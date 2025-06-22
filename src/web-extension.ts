/*
 * web-extension.ts (and activateRingDebug.ts) forms the "plugin" that plugs into VS Code and contains the code that
 * connects VS Code with the debug adapter.
 * 
 * web-extension.ts launches the debug adapter "inlined" because that's the only supported mode for running the debug adapter in the browser.
 */

import * as vscode from 'vscode';
import { activateRingDebug } from './activateRingDebug';

export function activate(context: vscode.ExtensionContext) {
	activateRingDebug(context);	// activateRingDebug without 2nd argument launches the Debug Adapter "inlined"
}

export function deactivate() {
	// nothing to do
}
