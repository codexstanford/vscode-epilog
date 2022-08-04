import * as lsp from 'vscode-languageserver/node';

/** Debounce lifted from Underscore */
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