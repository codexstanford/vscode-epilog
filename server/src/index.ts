/**
 * @fileoverview Entry point for the LSP server.
 */

import * as lsp from 'vscode-languageserver/node';
import * as Parser from 'web-tree-sitter';
import * as path from 'path';

import * as util from '#util';
import * as ast from '#util/ast';

let parser: Parser;

const connection = lsp.createConnection();

const documents: Map<string, { text: string, tree: Parser.Tree }> = new Map();

connection.onInitialize(async () => {
    // Don't die on unhandled promise rejections
    process.on("unhandledRejection", (reason, p) => {
        connection.console.error(
            `Unhandled rejection of promise ${p}. Reason: ${reason}`,
        );
    });

    parser = await ast.loadParser(
        path.relative(
            process.cwd(),
            path.join(
                __dirname,
                '..', '..',
                'node_modules',
                '@codexstanford',
                'tree-sitter-epilog',
                'tree-sitter-epilog.wasm'))
    );

    const result: lsp.InitializeResult = {
        capabilities: {
            textDocumentSync: lsp.TextDocumentSyncKind.Incremental
        }
    };

    return result;
});

connection.onDidOpenTextDocument(e => {
    const ast = parser.parse(e.textDocument.text);
    documents.set(e.textDocument.uri, { text: e.textDocument.text, tree: ast });

    diagnoseDocument(e.textDocument.uri, ast);
});

connection.onDidChangeTextDocument((e: lsp.DidChangeTextDocumentParams) => {
    e.contentChanges.forEach(change => {
        if ('range' in change) { // incremental update
            const previous = documents.get(e.textDocument.uri)!;
            const [start, end] = util.getIndicesFromRange(change.range, previous.text);
            const newText = previous.text.substring(0, start) + change.text + previous.text.substring(end);
            const newTree = ast.updateAst(parser, previous.tree, change, newText);
            documents.set(e.textDocument.uri, {
                text: newText,
                tree: newTree
            });
        } else { // full resync
            documents.set(e.textDocument.uri, {
                text: change.text,
                tree: parser.parse(change.text)
            });
        }
    });

    diagnoseDocument(e.textDocument.uri, documents.get(e.textDocument.uri)!.tree);
});

connection.onDidCloseTextDocument(e => {
    documents.delete(e.textDocument.uri);
});

async function diagnoseDocument(uri: string, tree: Parser.Tree): Promise<void> {
    connection.sendDiagnostics({
        uri,
        diagnostics: [
            diagnoseErrors(tree),
            diagnoseUnsafeVariables(tree)
        ].flat()
    });
}

function diagnoseErrors(tree: Parser.Tree): lsp.Diagnostic[] {
    const diagnostics: lsp.Diagnostic[] = [];

    parser.getLanguage().query(`
        (ERROR) @error
    `).captures(tree.rootNode).forEach(capture => {
        diagnostics.push({
            message: "Parse error",
            source: 'epilog',
            range: {
                start: ast.toLspPosition(capture.node.startPosition),
                end: ast.toLspPosition(capture.node.endPosition)
            },
            severity: lsp.DiagnosticSeverity.Error
        });
    });

    return diagnostics;
}

function diagnoseUnsafeVariables(tree: Parser.Tree): lsp.Diagnostic[] {
    const diagnostics: lsp.Diagnostic[] = [];

    parser.getLanguage().query(`
        (rule
          head: (literal) @head
          body: (rule_body) @body)
    `).matches(tree.rootNode).forEach(match => {
        let head: Parser.SyntaxNode, body: Parser.SyntaxNode;
        match.captures.forEach(capture => {
            if (capture.name === 'head') head = capture.node;
            if (capture.name === 'body') body = capture.node;
        });

        let checkVariables: Map<string, Parser.SyntaxNode[]> = new Map();

        // Collect variables from head
        parser.getLanguage().query(`
            (variable) @variable
        `).captures(head!).forEach(capture => {
            if (!checkVariables.has(capture.node.text)) checkVariables.set(capture.node.text, []);
            checkVariables.get(capture.node.text)!.push(capture.node);
        });

        // Collect variables from negative literals
        parser.getLanguage().query(`
            (literal
              (op_negate)) @negative_literal
        `).captures(body!).forEach(capture => {
            const negativeLiteral = capture.node;
            parser.getLanguage().query(`
                (variable) @variable
            `).captures(negativeLiteral).forEach(capture => {
                if (!checkVariables.has(capture.node.text)) checkVariables.set(capture.node.text, []);
                checkVariables.get(capture.node.text)!.push(capture.node);
            });
        });

        const checkedSafe: string[] = [];

        checkVariables.forEach((nodes, varName) => {
            parser.getLanguage().query(`
                (
                  (variable) @variable
                  (#match? @variable "${varName}")
                )
            `).captures(body).forEach(capture => {
                // If we have an instance of the variable that isn't itself one
                // of the potentially unsafe instances, then the variable is safe.
                if (!checkVariables.get(varName)!.find(v => v.id === capture.node.id)) {
                    checkedSafe.push(varName);
                }
            });
        });

        checkedSafe.forEach(varName => {
            checkVariables.delete(varName);
        });

        checkVariables.forEach((nodes, varName) => {
            nodes.forEach(node => {
                diagnostics.push({
                    message: `Unsafe variable: "${varName}" does not appear in any positive literals in this rule.`,
                    source: 'epilog',
                    range: {
                        start: ast.toLspPosition(node.startPosition),
                        end: ast.toLspPosition(node.endPosition)
                    },
                    severity: lsp.DiagnosticSeverity.Warning
                });
            });
        });
    });

    return diagnostics;
}

connection.listen();
