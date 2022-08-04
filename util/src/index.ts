/**
 * @fileoverview General-purpose utilities.
 */

import * as lsp from 'vscode-languageserver/node';

// Debounce lifted from Underscore
export function debounce(f: Function, wait: number, immediate = false) {
    let timeout: any;
    return function () {
        var context = this, args = arguments;
        var later = function () {
            timeout = null;
            if (!immediate) f.apply(context, args);
        };
        var callNow = immediate && !timeout;
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
        if (callNow) f.apply(context, args);
    };
};

/**
 * @param o an object
 * @param keys an array of keys
 * @returns a new object with just the properties of `o` named in `keys`
 */
export function pick(o: any, keys: string[]) {
    return keys.filter(k => k in o).reduce((out: any, k) => {
        out[k] = o[k];
        return out;
    }, {});
}

export function addPositions(pos1: lsp.Position, pos2: lsp.Position): lsp.Position {
    return lsp.Position.create(
        pos1.line + pos2.line,
        pos1.character + pos2.character
    );
}

/**
 * Compute the start and end indices of `range` within `text`.
 * 
 * `range` is given in terms of lines and columns, but `text` is just a string,
 * so there's a bit of line-searching to do.
 */
export function getIndicesFromRange(
    range: lsp.Range,
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