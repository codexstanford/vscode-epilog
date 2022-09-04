/**
 * @fileoverview Epilog graph editor, backed by the logic-graph package.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';

import * as epilog from '../../epilog/out/epilog';
import * as explain from '../../epilog/out/explain';
import * as vscUtil from './vscUtil';
import * as util from '../../util/out';
import * as ast from '../../util/out/ast';

// logic-graph includes its own static `index.html` and compiled `app.js`.
// We'll use these to set up our Webview.
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

        Promise.all([parserLoad, rawHtml])
            .then(([resolvedParser, rawHtmlResolved]) => {
                // Cache the loaded parser, or a no-op if we already had it
                preloadedParser = resolvedParser;

                // Initialize webview
                webviewPanel.webview.options = { enableScripts: true };
                webviewPanel.webview.html = assembleGraphHtml(
                    rawHtmlResolved,
                    webviewPanel.webview,
                    this.context);

                new GraphEditor(document, webviewPanel, resolvedParser);

                // will update graph with AST after appReady message received
            });
    }
}

class GraphEditor {
    private tree: Parser.Tree;

    constructor(
        private readonly document: vscode.TextDocument,
        private readonly webviewPanel: vscode.WebviewPanel,
        private readonly parser: Parser) {
        // Initialize AST
        this.tree = this.parser.parse(document.getText());

        // Listen for text document changes

        const _rerenderGraph = util.debounce(() => {
            updateGraphFromParse(webviewPanel.webview, this.parser, this.tree);
        }, 100);

        const textChangeSub = vscode.workspace.onDidChangeTextDocument(
            (evt: vscode.TextDocumentChangeEvent) => {
                if (evt.document.uri.toString() !== document.uri.toString()) return;

                for (const change of evt.contentChanges) {
                    this.tree = ast.updateAst(this.parser, this.tree, change, evt.document.getText());
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
                // Web app has finished setting up and is ready to receive messages.
                // Set the target language to Epilog and send the initial program state.
                initGraphForEpilog(this.webviewPanel.webview);
                readPositions(vscode.workspace.getWorkspaceFolder(this.document.uri)).then(positions => {
                    setGraphPositions(this.webviewPanel.webview, positions);
                    updateGraphFromParse(this.webviewPanel.webview, this.parser, this.tree);
                });
                break;
            case 'positionsEdited':
                const folder = vscode.workspace.getWorkspaceFolder(this.document.uri);
                // If no workspace, nowhere to store positions.
                // TODO is there a way for the extension to require a workspace?
                if (!folder) return;
                writePositions(folder, message.positions);
                break;
            case 'negateLiteral': {
                const predicateNode = ast.findContainingNode(this.tree.rootNode, message.startPosition);
                const literalNode = predicateNode?.parent;
                if (!literalNode) throw new Error("Parent literal not found for negate");

                const startPosition = vscUtil.positionFromTS(message.startPosition);
                const edit = new vscode.WorkspaceEdit();
                const value = epilog.read(literalNode.text);
                if (value.length && value[0] === 'not') {
                    // If literal is already negative, remove the leading ~
                    // TODO tolerate whitespace: use Tree-sitter to find the
                    // exact extent of the negation operator
                    edit.delete(
                        this.document.uri,
                        new vscode.Range(
                            new vscode.Position(startPosition.line, startPosition.character - 1),
                            startPosition)
                    );
                } else {
                    // If literal is positive, add a leading ~
                    edit.insert(
                        this.document.uri,
                        vscUtil.positionFromTS(message.startPosition),
                        '~');
                }
                vscode.workspace.applyEdit(edit);
                break;
            }
            case 'query': {
                const dataPath = path.join(
                    path.dirname(this.document.uri.fsPath),
                    'data.epilog');
                
                Promise.all([
                    fs.readFile(dataPath, { encoding: 'utf-8' })
                ]).then(([data]) => {
                    const dataset: any[] = [];
                    epilog.definefacts(dataset, epilog.readdata(data));
                    const ruleset: any[] = [];
                    epilog.definerules(ruleset, epilog.readdata(this.document.getText()));
                    const result = epilog.compfinds(
                        epilog.read(message.query), 
                        epilog.read(message.query), 
                        dataset, 
                        ruleset);
                    sendQueryResult(this.webviewPanel.webview, message.query, result.map((instance: any) => {
                        return new explain.Explanation(instance, dataset, ruleset);
                    }));
                });
                break;
            }
            case 'focusRange': {
                this.ifEditor(editor => {
                    selectRange(editor, vscUtil.rangeFromTS(message.range));
                    vscode.window.showTextDocument(this.document, { preview: false, viewColumn: editor.viewColumn });
                });

                break;
            }
            case 'selectRange': {
                this.ifEditor(editor => {
                    selectRange(editor, vscUtil.rangeFromTS(message.range));
                });

                break;
            }
            case 'showRange': {
                this.ifEditor(editor => {
                    editor.revealRange(vscUtil.rangeFromTS(message.range));
                });

                break;
            }
            default:
                console.log("Received unrecognized message:", message);
        }
    }

    private ifEditor(fn: (e: vscode.TextEditor) => void): void {
        const editor = vscode.window.visibleTextEditors.find(ed => ed.document === this.document);
        if (editor) fn(editor);
    }
}

class LiteralViewModel {
    predicate: {
        text: string,
        startPosition: Parser.Point,
        endPosition: Parser.Point
    };
    args: {
        type: string,
        text: string,
        startPosition: Parser.Point,
        endPosition: Parser.Point
    }[] = [];
    negative = false;
    repr: string;

    constructor(expr: ast.Expression) {
        Object.assign(this, util.pick(expr, [
            'type',
            'text',
            'startPosition',
            'endPosition',
            'nodeId',
            'value'
        ]));

        this.repr = epilog.grind(expr.value);

        this.negative = epilog.negativep(expr.value);

        const predicateNode = expr.node.childForFieldName('predicate');
        if (!predicateNode) throw new Error("Impossible AST: Literal without predicate");
        this.predicate = util.pick(predicateNode, ['text', 'startPosition', 'endPosition']);

        const argsNode = expr.node.childForFieldName('args');
        this.args = (argsNode ? argsNode.namedChildren : []).map(argNode => {
            return util.pick(argNode, ['type', 'text', 'startPosition', 'endPosition']);
        });
    }
}

function astToGraphModel(parser: Parser, tree: Parser.Tree) {
    const db: any = { rules: {}, matches: [] };
    const ruleHeads: ast.Expression[] = [];

    // Add all the rules first, grouped by head
    parser.getLanguage().query(`
		(rule
		  head: (literal) @head)
	`).captures(tree.rootNode).forEach(headCapture => {
        const head = new ast.Expression(headCapture.node);
        ruleHeads.push(head);
        const repr = epilog.grind(head.value);
        db.rules[repr] = db.rules[repr] || [];
        db.rules[repr].push({
            head: new LiteralViewModel(head),
            body: (headCapture.node.nextNamedSibling?.namedChildren || []).map(bodyLiteral => {
                return new LiteralViewModel(new ast.Expression(bodyLiteral));
            })
        });
    });

    // Add top-level literals too
    const cursor  = tree.rootNode.walk();
    cursor.gotoFirstChild();
    do {
        const node = cursor.currentNode();
        if (node.type === 'literal') {
            const literal = new ast.Expression(node);
            ruleHeads.push(literal);
            const repr = epilog.grind(literal.value);
            db.rules[repr] = db.rules[repr] || [];
            db.rules[repr].push({ head: new LiteralViewModel(literal), body: [] });
        }
    } while (cursor.gotoNextSibling());

    // Search through rules for matches between heads and body literals
    parser.getLanguage().query(`
		(rule
		  head: (literal) @head
		  body: (rule_body) @body)
	`).matches(tree.rootNode).forEach(match => {
        const headCapture = match.captures.find(c => c.name === 'head');
        const bodyCapture = match.captures.find(c => c.name === 'body');

        if (!headCapture || !bodyCapture) throw new Error("Impossible AST");

        const head = new ast.Expression(headCapture.node);

        // For each head/body literal match, we want (1) a path to the body literal, which looks
        // like [rule head, source index of the rule matching that head, source index of the literal]
        // and (2) a path to the matching rule head, which is the same minus the last component. 
        bodyCapture.node.namedChildren.forEach((bodyLiteral, subgoalIdx) => {
            const literal = new ast.Expression(bodyLiteral);

            ruleHeads.filter(head => {
                if (epilog.negativep(literal.value)) {
                    return epilog.matchp(literal.value[1], head.value);
                } else {
                    return epilog.matchp(literal.value, head.value);
                }
            }).forEach(matchingHead => {
                const matchingHeadRepr = epilog.grind(matchingHead.value);
                Object.entries(db.rules[matchingHeadRepr]).forEach((_, matchingBodyIdx) => {
                    const bodyIdx = ruleHeads
                        .filter(l => epilog.grind(l.value) === matchingHeadRepr)
                        .findIndex(l => l.node.id === matchingHead.node.id);
                    db.matches.push({
                        subgoal: [epilog.grind(head.value), bodyIdx, subgoalIdx],
                        rule: [matchingHeadRepr, matchingBodyIdx]
                    });
                });
            });
        });
    });

    return db;
}

function selectRange(editor: vscode.TextEditor, range: vscode.Range): void {
    editor.revealRange(range);
    editor.selection = new vscode.Selection(range.start, range.end);
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

function sendQueryResult(webview: vscode.Webview, query: string, result: any[]): void {
    webview.postMessage({
        'type': 'lide.queryResult',
        'query': query,
        'result': result
    });
}

function setGraphPositions(webview: vscode.Webview, positions: any): void {
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

function writePositions(folder: vscode.WorkspaceFolder, positions: any): Promise<void> {
    return fs.mkdir(path.dirname(getPositionsFilePath(folder)), { recursive: true })
        .then(() => {
            return fs.writeFile(getPositionsFilePath(folder), JSON.stringify(positions, null, 2));
        });
}
