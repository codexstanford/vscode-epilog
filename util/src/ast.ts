import * as lsp from 'vscode-languageserver/node';
import * as Parser from 'web-tree-sitter';

import * as util from '.';

export class Literal {
    args: Parser.SyntaxNode[];
    predicate: { text: string; };
    nodeId: number;
    negative: boolean;

    constructor(node: Parser.SyntaxNode) {
        this.nodeId = node.id;
        this.negative = node.firstChild?.type === 'op_negate';

        const predicateNode = node.childForFieldName('predicate');
        if (!predicateNode) throw new Error("Impossible AST: Literal without predicate");
        this.predicate = util.pick(predicateNode, ['text', 'startPosition', 'endPosition']);

        const argsNode = node.childForFieldName('args');
        this.args = (argsNode ? argsNode.namedChildren : []).map(argNode => {
            return util.pick(argNode, ['type', 'text', 'startPosition', 'endPosition']);
        });
    }

    public toCode(): string {
        return (this.negative ? '~' : '') + this.predicate.text + '(' + this.args.map(arg => arg.text).join(',') + ')';
    }
}

export async function loadParser(wasmPath: string): Promise<Parser> {
	await Parser.init();
	const parser = new Parser();
	// tree-sitter manual notes that wasm is "considerably slower" than using
	// Node bindings, but using the Node bindings from VS Code is a PITA. See:
	// https://github.com/microsoft/vscode/issues/658
	// https://github.com/elm-tooling/elm-language-server/issues/692
	// https://github.com/tree-sitter/node-tree-sitter/issues/111
	// https://stackoverflow.com/questions/45062881/custom-node-version-to-run-vscode-extensions
	const epilogLang = await Parser.Language.load(wasmPath);
	parser.setLanguage(epilogLang);
    return parser;
}

/** 
 * Reparse `fullText` after `change`, using the results of the previous parse `previousTree`.
 * 
 * Mutates `previousTree` *and* returns a new tree.
 */
export function updateAst(
    parser: Parser,
    previousTree: Parser.Tree,
    change: { range: lsp.Range, text: string },
    fullText: string): Parser.Tree {
    previousTree.edit(getEditFromChange(change, previousTree.rootNode.text));
    return parser.parse(fullText, previousTree);
}

/** 
 * Literals `a` and `b` match if they have the same predicate, same arity, and
 * any ground arguments are the same.
 */
export function matches(a: Literal, b: Literal): Boolean {
    if (a.predicate.text !== b.predicate.text) return false;
    if (a.args.length !== b.args.length) return false;

    for (let i = 0; i < a.args.length; i++) {
        if (a.args[i].type !== 'variable' &&
            b.args[i].type !== 'variable' &&
            a.args[i].text !== b.args[i].text) {
            return false;
        }
    }

    return true;
}

export function findLineage(node: Parser.SyntaxNode) {
    let lineage = [], currentNode: Parser.SyntaxNode | null = node;
    while (currentNode) {
        lineage.unshift(currentNode);
        currentNode = node.parent;
    }
    return lineage;
}

export function findContainingNode(root: Parser.SyntaxNode, point: Parser.Point): Parser.SyntaxNode | null {
    return findContainingNodeWithCursor(root.walk(), point);
}

function findContainingNodeWithCursor(cursor: Parser.TreeCursor, point: Parser.Point): Parser.SyntaxNode | null {
    const current = cursor.currentNode();

    // If `point` is outside the range of this node, it can't be inside any
    // of its descendants either. Try a sibling.
    if (comparePoints(current.startPosition, point) > 0 ||
        comparePoints(current.endPosition, point)   < 0) {
        if (cursor.gotoNextSibling()) {
            return findContainingNodeWithCursor(cursor, point);
        } else {
            return null;
        }
    }

    // `current` is a container for `point`, but maybe we can find a more
    // specific descendant.
    if (cursor.gotoFirstChild()) {
        return findContainingNodeWithCursor(cursor, point) || current;
    }

    return current;
}

/** Get a Tree-sitter Edit corresponding to a replacement by `change.text` at
 * `change.range` within `text`. */
export function getEditFromChange(
    change: { text: string; range: lsp.Range },
    text: string,
): Parser.Edit {
    const [startIndex, endIndex] = util.getIndicesFromRange(
        change.range,
        text
    );

    return {
        startIndex,
        oldEndIndex: endIndex,
        newEndIndex: startIndex + change.text.length,
        startPosition: toTSPoint(change.range.start),
        oldEndPosition: toTSPoint(change.range.end),
        newEndPosition: toTSPoint(
            util.addPositions(change.range.start, textToPosition(change.text)),
        ),
    };
}

export function toLspPosition(tsPoint: Parser.Point): lsp.Position {
    return lsp.Position.create(tsPoint.row, tsPoint.column);
}

export function toTsPoint(position: lsp.Position): Parser.Point {
    return { row: position.line, column: position.character };
}

export function toVSRange(tsRange: [Parser.Point, Parser.Point]) {
    return lsp.Range.create(toLspPosition(tsRange[0]), toLspPosition(tsRange[1]));
}

function comparePoints(a: Parser.Point, b: Parser.Point): number {
    if (a.row > b.row) return 1;
    if (a.row < b.row) return -1;
    if (a.column > b.column) return 1;
    if (a.column < b.column) return -1;
    return 0;
}

function toTSPoint(position: lsp.Position): Parser.Point {
    return { row: position.line, column: position.character };
}

function textToPosition(text: string): lsp.Position {
    const lines = text.split(/\r\n|\r|\n/);

    return lsp.Position.create(
        lines.length - 1,
        lines[lines.length - 1].length
    );
}