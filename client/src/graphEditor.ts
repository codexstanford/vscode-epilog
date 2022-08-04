import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';

import * as vscUtil from './vscUtil';
import * as util from '../../util/out';
import * as ast from '../../util/out/ast';

const graphHtmlRelativePath = path.join('node_modules', '@wohanley', 'logic-graph', 'resources', 'public', 'index.html');
const graphJsRelativePath = path.join('node_modules', '@wohanley', 'logic-graph', 'resources', 'public', 'js', 'compiled', 'app.js');

let preloadedParser: Parser;

export class EpilogGraphEditorProvider implements vscode.CustomTextEditorProvider {
    constructor(private readonly context: vscode.ExtensionContext) { }

    public resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken): void {
        // Async initialization stuff is handled here so that GraphEditor
        // doesn't have to worry about nulls.
        const parserLoad = preloadedParser
            ? Promise.resolve(preloadedParser)
            : ast.loadParser(
                path.join(
                    this.context.extensionPath,
                    'node_modules', 'tree-sitter-epilog', 'tree-sitter-epilog.wasm'));

        const rawHtml = fs.readFile(
            path.join(this.context.extensionPath, graphHtmlRelativePath),
            { encoding: 'utf-8' });

        const positions = readPositions(vscode.workspace.getWorkspaceFolder(document.uri));

        Promise.all([parserLoad, rawHtml, positions])
            .then(([resolvedParser, rawHtmlResolved, positionsResolved]) => {
                preloadedParser = resolvedParser;

                // Initialize webview
                webviewPanel.webview.options = { enableScripts: true };
                webviewPanel.webview.html = assembleGraphHtml(
                    rawHtmlResolved,
                    webviewPanel.webview,
                    this.context);

                setGraphPositions(webviewPanel.webview, positionsResolved);

                new GraphEditor(document, webviewPanel, resolvedParser);

                // will update graph with AST after appReady message received
            });
    }
}

class GraphEditor {
    private ast: Parser.Tree;

    constructor(
        private readonly document: vscode.TextDocument,
        private readonly webviewPanel: vscode.WebviewPanel,
        private readonly parser: Parser) {
        // Initialize AST
        this.ast = this.parser.parse(document.getText());

        // Listen for text document changes

        const _rerenderGraph = util.debounce(() => {
            updateGraphFromParse(webviewPanel.webview, this.parser, this.ast);
        }, 100);

        const textChangeSub = vscode.workspace.onDidChangeTextDocument(
            (evt: vscode.TextDocumentChangeEvent) => {
                if (evt.document.uri.toString() !== document.uri.toString()) return;

                for (const change of evt.contentChanges) {
                    ast.updateAst(this.parser, this.ast, change, evt.document.getText());
                }

                _rerenderGraph();
            });

        webviewPanel.onDidDispose(textChangeSub.dispose);

        // Listen for graph editor changes
        const graphChangeSub = webviewPanel.webview.onDidReceiveMessage(this.handleMessage.bind(this));
        webviewPanel.onDidDispose(graphChangeSub.dispose);
    }

    private handleMessage(message: any) {
        switch (message.type) {
            case 'appReady':
                initGraphForEpilog(this.webviewPanel.webview);
                updateGraphFromParse(this.webviewPanel.webview, this.parser, this.ast);
                break;
            case 'positionsEdited':
                const folder = vscode.workspace.getWorkspaceFolder(this.document.uri);
                // If no workspace, nowhere to store positions.
                // TODO is there a way for the extension to require a workspace?
                if (!folder) return;
                writePositions(folder, message.positions);
                break;
            case 'negateLiteral': {
                const predicateNode = ast.findContainingNode(this.ast.rootNode, message.startPosition);
                const literalNode = predicateNode?.parent;
                if (!literalNode) throw new Error("Parent literal not found for negate");

                const startPosition = vscUtil.positionFromTS(message.startPosition);
                const edit = new vscode.WorkspaceEdit();
                if (new ast.Literal(literalNode).negative) {
                    edit.delete(
                        this.document.uri,
                        new vscode.Range(
                            new vscode.Position(startPosition.line, startPosition.character - 1),
                            startPosition)
                    );
                } else {
                    edit.insert(
                        this.document.uri,
                        vscUtil.positionFromTS(message.startPosition),
                        '~');
                }
                vscode.workspace.applyEdit(edit);
                break;
            }
            case 'selectRange': {
                const editor = vscode.window.visibleTextEditors.find(ed => ed.document === this.document);

                if (editor) {
                    const [startPosition, endPosition] = message.range;
                    editor.revealRange(vscUtil.rangeFromTS(message.range));
                    editor.selection = new vscode.Selection(
                        vscUtil.positionFromTS(startPosition),
                        vscUtil.positionFromTS(endPosition));
                }

                break;
            }
            case 'showRange': {
                const editor = vscode.window.visibleTextEditors.find(ed => ed.document === this.document);

                if (editor) {
                    editor.revealRange(vscUtil.rangeFromTS(message.range));
                }

                break;
            }
            default:
                console.log("Received unrecognized message:", message);
        }
    }
}

function astToGraphModel(parser: Parser, tree: Parser.Tree) {
    const db: any = { rules: {}, matches: [] };
    const ruleHeads: ast.Literal[] = [];

    // Create all the rules first
    parser.getLanguage().query(`
		(rule
		  head: (literal) @head)
	`).captures(tree.rootNode).forEach(headCapture => {
        const head = new ast.Literal(headCapture.node);
        ruleHeads.push(head);
        const headCode = head.toCode();
        db.rules[headCode] = db.rules[headCode] || [];
        db.rules[headCode].push({
            head,
            body: (headCapture.node.nextNamedSibling?.namedChildren || []).map(bodyLiteral => {
                return new ast.Literal(bodyLiteral);
            })
        });
    });

    parser.getLanguage().query(`
		(rule
		  head: (literal) @head
		  body: (rule_body) @body)
	`).matches(tree.rootNode).forEach(match => {
        const headCapture = match.captures.find(c => c.name === 'head');
        const bodyCapture = match.captures.find(c => c.name === 'body');

        if (!headCapture || !bodyCapture) throw new Error("Impossible AST");

        const head = new ast.Literal(headCapture.node);

        bodyCapture.node.namedChildren.forEach((bodyLiteral, subgoalIdx) => {
            const literal = new ast.Literal(bodyLiteral);

            ruleHeads.filter(head => {
                return ast.matches(head, literal);
            }).forEach(matchingHead => {
                const matchingHeadCode = matchingHead.toCode();
                Object.entries(db.rules[matchingHeadCode]).forEach((_, matchingBodyIdx) => {
                    const bodyIdx = ruleHeads
                        .filter(l => l.toCode() === matchingHeadCode)
                        .findIndex(l => l.nodeId === matchingHead.nodeId);
                    db.matches.push({
                        subgoal: [head.toCode(), bodyIdx, subgoalIdx],
                        rule: [matchingHeadCode, matchingBodyIdx]
                    });
                });
            });
        });
    });

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
function assembleGraphHtml(
    htmlString: String,
    webview: vscode.Webview,
    context: vscode.ExtensionContext): string {
    const jsUri = vscode.Uri.file(path.join(context.extensionPath, graphJsRelativePath));
    return htmlString.replace("/js/compiled/app.js", webview.asWebviewUri(jsUri).toString());
}

function initGraphForEpilog(webview: vscode.Webview): void {
    webview.postMessage({
        type: 'lide.initForLanguage',
        language: 'epilog'
    });
}

function updateGraphFromParse(webview: vscode.Webview, parser: Parser, ast: Parser.Tree): void {
    webview.postMessage({
        'type': 'lide.codeUpdated.epilog',
        'model': astToGraphModel(parser, ast)
    });
}

function setGraphPositions(webview: vscode.Webview, positions: any) {
    webview.postMessage({
        'type': 'lide.positionsRead',
        'positions': positions
    });
}

function getPositionsFilePath(folder: vscode.WorkspaceFolder): string {
    return path.join(folder.uri.fsPath, '.lide', 'positions.json');
}

function readPositions(folder: vscode.WorkspaceFolder | undefined) {
    const empty = { rule: {}, fact: {} };

    if (!folder) return Promise.resolve(empty);

    return fs.mkdir(path.dirname(getPositionsFilePath(folder)), { recursive: true })
        .then(() => fs.readFile(getPositionsFilePath(folder), { encoding: 'utf-8' }))
        .then(JSON.parse)
        .catch(() => empty);
}

function writePositions(folder: vscode.WorkspaceFolder, positions: any) {
    return fs.mkdir(path.dirname(getPositionsFilePath(folder)), { recursive: true })
        .then(() => {
            fs.writeFile(getPositionsFilePath(folder), JSON.stringify(positions, null, 2));
        });
}
