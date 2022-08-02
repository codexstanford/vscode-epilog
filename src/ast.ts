import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';

import * as util from './util';

export class Literal {
    args: { text: string }[];
    predicate: { text: string; };
    negated = false;

    constructor(node: Parser.SyntaxNode) {
        this.negated = node.firstChild?.type === 'op_negate';

        const predicateNode = node.childForFieldName('predicate');
        if (!predicateNode) throw new Error("Impossible AST: Literal without predicate");
        this.predicate = util.pick(predicateNode, ['text', 'startPosition', 'endPosition']);

        const argsNode = node.childForFieldName('args');
        this.args = (argsNode ? argsNode.namedChildren : []).map(argNode => {
            return util.pick(argNode, ['text', 'startPosition', 'endPosition']);
        });
    }

    public toCode(): string {
        return (this.negated ? '~' : '') + this.predicate.text + '(' + this.args.map(arg => arg.text).join(',') + ')';
    }
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
    change: { text: string; range: vscode.Range },
    text: string,
): Parser.Edit {
    const [startIndex, endIndex] = getIndicesFromRange(
        change.range,
        text,
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

export function toVSPosition(tsPoint: Parser.Point) {
    return new vscode.Position(tsPoint.row, tsPoint.column);
}

export function toVSRange(tsRange: [Parser.Point, Parser.Point]) {
    return new vscode.Range(toVSPosition(tsRange[0]), toVSPosition(tsRange[1]));
}

function comparePoints(a: Parser.Point, b: Parser.Point): number {
    if (a.row > b.row) return 1;
    if (a.row < b.row) return -1;
    if (a.column > b.column) return 1;
    if (a.column < b.column) return -1;
    return 0;
}

function getIndicesFromRange(
    range: vscode.Range,
    text: string,
): [number, number] {
    let startIndex = range.start.character;
    let endIndex = range.end.character;

    const regex = new RegExp(/\r\n|\r|\n/);
    const eolResult = regex.exec(text);

    const lines = text.split(regex);
    const eol = eolResult && eolResult.length > 0 ? eolResult[0] : "";

    for (let i = 0; i < range.end.line; i++) {
        if (i < range.start.line) {
            startIndex += lines[i].length + eol.length;
        }
        endIndex += lines[i].length + eol.length;
    }

    return [startIndex, endIndex];
}

function toTSPoint(position: vscode.Position): Parser.Point {
    return { row: position.line, column: position.character };
}

function textToPosition(text: string): vscode.Position {
    const lines = text.split(/\r\n|\r|\n/);

    return new vscode.Position(
        lines.length - 1,
        lines[lines.length - 1].length
    );
}