import {
    Diagnostic,
    DiagnosticSeverity,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
    TextDocumentSyncKind,
    InitializeResult
} from 'vscode-languageserver/node';

import * as vsls from 'vscode-languageserver/node';
import * as lstext from 'vscode-languageserver-textdocument';
import * as Parser from 'web-tree-sitter';
import * as path from 'path';

import * as ast from '../../util/out/ast';

let parser: Parser;

const connection = vsls.createConnection();

const documents: vsls.TextDocuments<lstext.TextDocument> = new vsls.TextDocuments(lstext.TextDocument);
const forest: Map<string, Parser.Tree> = new Map();

connection.onInitialize(async (_params) => {
    // Don't die on unhandled promise rejections
    process.on("unhandledRejection", (reason, p) => {
        connection.console.error(
            `Unhandled rejection of promise ${p}. Reason: ${reason}`,
        );
    });

    parser = await ast.loadParser(
        path.relative(
            process.cwd(),
            path.join(__dirname, '..', '..', 'node_modules', 'tree-sitter-epilog', 'tree-sitter-epilog.wasm'))
    );

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental
        }
    };

    return result;
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(e => {
    const ast = parser.parse(e.document.getText());
    forest.set(e.document.uri, ast);

    diagnoseDocument(e.document, ast);
});

documents.onDidClose(e => {
    forest.delete(e.document.uri);
});

async function diagnoseDocument(textDocument: lstext.TextDocument, tree: Parser.Tree): Promise<void> {
    const diagnostics: Diagnostic[] = [];

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
                    message: `Unsafe variable: ${varName} does not appear in any positive literals in this rule.`,
                    source: 'epilog',
                    range: {
                        start: ast.toLspPosition(node.startPosition),
                        end: ast.toLspPosition(node.endPosition)
                    },
                    severity: DiagnosticSeverity.Warning
                });
            });
        });
    });

    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

// This handler provides the initial list of the completion items.
// connection.onCompletion(
//     (_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
//         // The pass parameter contains the position of the text document in
//         // which code complete got requested. For the example we ignore this
//         // info and always provide the same completion items.
//         return [
//             {
//                 label: 'TypeScript',
//                 kind: CompletionItemKind.Text,
//                 data: 1
//             },
//             {
//                 label: 'JavaScript',
//                 kind: CompletionItemKind.Text,
//                 data: 2
//             }
//         ];
//     }
// );

// This handler resolves additional information for the item selected in
// the completion list.
// connection.onCompletionResolve(
//     (item: CompletionItem): CompletionItem => {
//         if (item.data === 1) {
//             item.detail = 'TypeScript details';
//             item.documentation = 'TypeScript documentation';
//         } else if (item.data === 2) {
//             item.detail = 'JavaScript details';
//             item.documentation = 'JavaScript documentation';
//         }
//         return item;
//     }
// );

// Text document manager listens for open, change and close text document
documents.listen(connection);

connection.listen();
