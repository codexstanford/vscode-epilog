import * as ts from 'web-tree-sitter';
import * as vsc from 'vscode';

export function positionFromTS(point: ts.Point) {
    return new vsc.Position(point.row, point.column);
}

export function rangeFromTS(range: ts.Range) {
    return new vsc.Range(
        new vsc.Position(range.startPosition.row, range.startPosition.column),
        new vsc.Position(range.endPosition.row, range.endPosition.column)
    );
}