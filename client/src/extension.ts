import * as path from 'path';
import * as vscode from 'vscode';
import * as lc from 'vscode-languageclient/node';

import * as graphEditor from './graphEditor';

let client: lc.LanguageClient;

export async function activate(context: vscode.ExtensionContext) {
	const serverModule = context.asAbsolutePath(path.join('server', 'out', 'index.js'));
	const debugOptions = { execArgv: ['--inspect=6009'] };
	const serverOptions: lc.ServerOptions = {
		run: {
			module: serverModule
		},
		debug: {
			module: serverModule,
			options: debugOptions
		}
	};

	const clientOptions: lc.LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'epilog' }],
		synchronize: {
			fileEvents: vscode.workspace.createFileSystemWatcher('**/*.epilog')
		}
	};

	// XXX Starting the client also starts the server, according to MS's LSP
	// example. Is the same true of stopping it? It does seem like the process
	// goes away after client.stop(), but is that reliable?
	client = new lc.LanguageClient('epilog', serverOptions, clientOptions);
	client.start();

	// Register subscriptions
	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(
			'epilog.graph',
			new graphEditor.EpilogGraphEditorProvider(context)));
}

export async function deactivate() {
	if (client) return client.stop();
}