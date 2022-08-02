import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';

import * as util from './util';

export class Literal {
    args: { text: string }[];
    predicate: { text: string; };

    constructor(node: Parser.SyntaxNode) {
        const predicateNode = node.childForFieldName('predicate');
        if (!predicateNode) throw new Error("Impossible AST: Literal without predicate");
        this.predicate = util.pick(predicateNode, ['text', 'startPosition', 'endPosition']);

        const argsNode = node.childForFieldName('args');
        this.args = (argsNode ? argsNode.namedChildren : []).map(argNode => {
            return util.pick(argNode, ['text', 'startPosition', 'endPosition']);
        });
    }

    public toCode(): string {
        return this.predicate.text + '(' + this.args.map(arg => arg.text).join(',') + ')';
    }
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
            addPositions(change.range.start, textToPosition(change.text)),
        ),
    };
}

export function toVSPosition(tsPoint: Parser.Point) {
    return new vscode.Position(tsPoint.row, tsPoint.column);
}

export function toVSRange(tsRange: [Parser.Point, Parser.Point]) {
    return new vscode.Range(toVSPosition(tsRange[0]), toVSPosition(tsRange[1]));
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

function addPositions(pos1: vscode.Position, pos2: vscode.Position): vscode.Position {
    return new vscode.Position(
        pos1.line + pos2.line,
        pos1.character + pos2.character
    );
}