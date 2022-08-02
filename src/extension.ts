import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';

import * as ast from './ast';
import * as util from './util';

const graphHtmlRelativePath = path.join('node_modules', '@wohanley', 'logic-graph', 'resources', 'public', 'index.html');
const graphJsRelativePath = path.join('node_modules', '@wohanley', 'logic-graph', 'resources', 'public', 'js', 'compiled', 'app.js');

let parser: Parser;
let epilogLang: Parser.Language;

export async function activate(context: vscode.ExtensionContext) {
	// Initialize tree-sitter parser
	await Parser.init();
	parser = new Parser();
	// tree-sitter manual notes that wasm is "considerably slower" than using
	// Node bindings, but using the Node bindings from VS Code is a PITA. See:
	// https://github.com/microsoft/vscode/issues/658
	// https://github.com/elm-tooling/elm-language-server/issues/692
	// https://github.com/tree-sitter/node-tree-sitter/issues/111
	// https://stackoverflow.com/questions/45062881/custom-node-version-to-run-vscode-extensions
	epilogLang = await Parser.Language.load(
		path.join(context.extensionPath, 'node_modules', 'tree-sitter-epilog', 'tree-sitter-epilog.wasm'));
	parser.setLanguage(epilogLang);

	// Register subscriptions
	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(
			'epilog.graph',
			new EpilogGraphEditorProvider(context)));
}

class EpilogGraphEditorProvider implements vscode.CustomTextEditorProvider {
	// Start with empty AST (better than null)
	private ast: Parser.Tree = parser.parse("");

	constructor(private readonly context: vscode.ExtensionContext) { }

	public resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel, token: vscode.CancellationToken): void {
		// Start loading required files
		const rawHtml = fs.readFile(
			path.join(this.context.extensionPath, graphHtmlRelativePath),
			{ encoding: 'utf-8' });
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
		const positions = _readPositions(workspaceFolder);

		// Initialize AST
		this.ast = parser.parse(document.getText());

		// Listen for text document changes

		const _rerenderGraph = util.debounce(() => {
			_updateGraphFromParse(webviewPanel.webview, this.ast);
		}, 100);

		const textChangeSub = vscode.workspace.onDidChangeTextDocument(
			(evt: vscode.TextDocumentChangeEvent) => {
				if (evt.document.uri.toString() !== document.uri.toString()) return;

				for (const change of evt.contentChanges) {
					this.updateAst(evt.document.getText(), change);
				}

				_rerenderGraph();
			});

		webviewPanel.onDidDispose(textChangeSub.dispose);

		// Listen for graph editor changes

		const graphChangeSub = webviewPanel.webview.onDidReceiveMessage(message => {
			switch (message.type) {
				case 'appReady':
					_initGraphForEpilog(webviewPanel.webview);
					_updateGraphFromParse(webviewPanel.webview, this.ast);
					break;
				case 'positionsEdited':
					const folder = vscode.workspace.getWorkspaceFolder(document.uri);
					// If no workspace, nowhere to store positions.
					// TODO is there a way for the extension to require a workspace?
					if (!folder) return;
					_writePositions(folder, message.positions);
					break;
				case 'negateLiteral': {
					const predicateNode = ast.findContainingNode(this.ast.rootNode, message.startPosition);
					const literalNode = predicateNode?.parent;
					if (!literalNode) throw new Error("Parent literal not found for negate");

					const startPosition = ast.toVSPosition(message.startPosition);
					const edit = new vscode.WorkspaceEdit();
					if (new ast.Literal(literalNode).negated) {
						edit.delete(
							document.uri,
							new vscode.Range(
								new vscode.Position(startPosition.line, startPosition.character - 1),
								startPosition)
						);
					} else {
						edit.insert(
							document.uri,
							ast.toVSPosition(message.startPosition),
							'~');
					}
					vscode.workspace.applyEdit(edit);
					break;
				}
				case 'selectRange': {
					const editor = vscode.window.visibleTextEditors.find(ed => ed.document === document);

					if (editor) {
						const [startPosition, endPosition] = message.range;
						editor.revealRange(ast.toVSRange(message.range));
						editor.selection = new vscode.Selection(
							ast.toVSPosition(startPosition),
							ast.toVSPosition(endPosition));
					}

					break;
				}
				case 'showRange': {
					const editor = vscode.window.visibleTextEditors.find(ed => ed.document === document);

					if (editor) {
						editor.revealRange(ast.toVSRange(message.range));
					}

					break;
				}
				default:
					console.log("Received unrecognized message:", message);
			}
		});

		webviewPanel.onDidDispose(graphChangeSub.dispose);

		// Finish graph init
		Promise.all([rawHtml, positions])
			.then(([rawHtmlResolved, positionsResolved]) => {
				webviewPanel.webview.options = { enableScripts: true };
				webviewPanel.webview.html = _assembleGraphHtml(
					rawHtmlResolved,
					webviewPanel.webview,
					this.context);

				_setGraphPositions(webviewPanel.webview, positionsResolved);

				// will update with AST after appReady message received
			});
	}

	private updateAst(fullText: string, change: { range: vscode.Range, text: string }) {
		this.ast.edit(
			ast.getEditFromChange(change, this.ast.rootNode.text)
		);

		this.ast = parser.parse(fullText, this.ast);
	}
}

function _gotoPreorderSucc(cursor: Parser.TreeCursor): boolean {
	if (cursor.gotoFirstChild()) return true;
	while (!cursor.gotoNextSibling()) {
		if (!cursor.gotoParent()) return false;
	}
	return true;
}

function _astToGraphModel(cursor: Parser.TreeCursor) {
	const db: any = { rules: {} };

	do {
		const currentNode = cursor.currentNode();

		switch (currentNode.type) {
			case 'rule': {
				const headNode = currentNode.childForFieldName('head');
				if (!headNode) throw new Error("Impossible AST: Rule with no head");
				const head = new ast.Literal(headNode);

				const body = currentNode.childForFieldName('body')?.namedChildren.map(bodyLiteral => {
					return new ast.Literal(bodyLiteral);
				});
				
				const headStr = head.toCode();
				db.rules[headStr] = db.rules[headStr] || [];
				db.rules[headStr].push({ head, body });

				break;
			}
		}
	} while (_gotoPreorderSucc(cursor));

	return db;
}

/**
 * Massages the HTML for the graph app to be usable by vscode. For now this just
 * consists of replacing the hardcoded path to the compiled JS with a
 * vscode-compatible URI.
 * 
 * @param htmlString the raw HTML string as read from disk
 * @param webview the webview into which the HTML will be rendered
 * @returns {string} the HTML with appropriate replacements made
 */
function _assembleGraphHtml(
	htmlString: String,
	webview: vscode.Webview,
	context: vscode.ExtensionContext): string {
	const jsUri = vscode.Uri.file(path.join(context.extensionPath, graphJsRelativePath));
	return htmlString.replace("/js/compiled/app.js", webview.asWebviewUri(jsUri).toString());
}

function _initGraphForEpilog(webview: vscode.Webview): void {
	webview.postMessage({
		type: 'lide.initForLanguage',
		language: 'epilog'
	 });
}

function _updateGraphFromParse(webview: vscode.Webview, ast: Parser.Tree): void {
	webview.postMessage({
		'type': 'lide.codeUpdated.epilog',
		'model': _astToGraphModel(ast.rootNode.walk())
	});
}

function _setGraphPositions(webview: vscode.Webview, positions: any) {
	webview.postMessage({
		'type': 'lide.positionsRead',
		'positions': positions
	});
}

function _getPositionsFilePath(folder: vscode.WorkspaceFolder): string {
	return path.join(folder.uri.fsPath, '.lide', 'positions.json');
}

function _readPositions(folder: vscode.WorkspaceFolder | undefined) {
	const empty = { rule: {}, fact: {} };

	if (!folder) return Promise.resolve(empty);

	return fs.mkdir(path.dirname(_getPositionsFilePath(folder)), { recursive: true })
		.then(() => fs.readFile(_getPositionsFilePath(folder), { encoding: 'utf-8' }))
		.then(JSON.parse)
		.catch(() => empty);
}

function _writePositions(folder: vscode.WorkspaceFolder, positions: any) {
	return fs.mkdir(path.dirname(_getPositionsFilePath(folder)), { recursive: true })
		.then(() => {
			fs.writeFile(_getPositionsFilePath(folder), JSON.stringify(positions, null, 2));
		});
}
