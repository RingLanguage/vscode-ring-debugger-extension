/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
/*
 * mockDebug.ts implements the Debug Adapter that "adapts" or translates the Debug Adapter Protocol (DAP) used by the client (e.g. VS Code)
 * into requests and events of the real "execution engine" or "debugger" (here: class MockRuntime).
 * When implementing your own debugger extension for VS Code, most of the work will go into the Debug Adapter.
 * Since the Debug Adapter is independent from VS Code, it can be used in any client (IDE) supporting the Debug Adapter Protocol.
 *
 * The most important class of the Debug Adapter is the MockDebugSession which implements many DAP requests by talking to the MockRuntime.
 */

import {
	Logger, logger,
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	ProgressStartEvent, ProgressUpdateEvent, ProgressEndEvent, InvalidatedEvent,
	Source, Handles, Breakpoint, MemoryEvent
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { basename } from 'path-browserify';
import { MockRuntime, IRuntimeBreakpoint, FileAccessor, RuntimeVariable, timeout, IRuntimeVariableType } from './mockRuntime';
import { Subject } from 'await-notify';
import * as base64 from 'base64-js';
import { spawn, ChildProcess } from 'child_process';

/**
 * This interface describes the mock-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the mock-debug extension.
 * The interface should always match this schema.
 */
interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
	/** run without debugging */
	noDebug?: boolean;
	/** if specified, results in a simulated compile error in launch. */
	compileError?: 'default' | 'show' | 'hide';
}

interface IAttachRequestArguments extends ILaunchRequestArguments { }


export class MockDebugSession extends LoggingDebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static threadID = 1;

	// a Mock runtime (or debugger)
	private _runtime: MockRuntime;

	private _variableHandles = new Handles<'locals' | 'globals' | RuntimeVariable>();

	private _configurationDone = new Subject();
	private _launchDone = new Subject();

	private _cancellationTokens = new Map<number, boolean>();

	private _reportProgress = false;
	private _progressId = 10000;
	private _cancelledProgressId: string | undefined = undefined;
	private _isProgressCancellable = true;

	private _valuesInHex = false;
	private _useInvalidatedEvent = false;

	private ringRdbProcess: ChildProcess | undefined;

	// 展示 extension 和 rdb 交换的详细日志
	private _showDebugRdbLog = false;

	// 
	// private _requestSeqMap: Map<number, number> = new Map<number, number>();


	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor(fileAccessor: FileAccessor) {
		super("mock-debug.txt");

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);

		this._runtime = new MockRuntime(fileAccessor);

		// setup event handlers
		this._runtime.on('stopOnEntry', () => {
			console.log('stopOnEntry');
			this.sendEvent(new StoppedEvent('entry', MockDebugSession.threadID));
			this.sendEvent(new StoppedEvent('entry', MockDebugSession.threadID + 1));
		});
		this._runtime.on('stopOnStep', () => {
			console.log('stopOnStep');
			this.sendEvent(new StoppedEvent('step', MockDebugSession.threadID));
		});
		this._runtime.on('stopOnBreakpoint', () => {
			console.log('stopOnBreakpoint');
			this.sendEvent(new StoppedEvent('breakpoint', MockDebugSession.threadID));
		});
		this._runtime.on('stopOnDataBreakpoint', () => {
			console.log('stopOnDataBreakpoint');
			this.sendEvent(new StoppedEvent('data breakpoint', MockDebugSession.threadID));
		});
		this._runtime.on('stopOnInstructionBreakpoint', () => {
			console.log('stopOnInstructionBreakpoint');
			this.sendEvent(new StoppedEvent('instruction breakpoint', MockDebugSession.threadID));
		});
		this._runtime.on('stopOnException', (exception) => {
			console.log('stopOnException');
			if (exception) {
				this.sendEvent(new StoppedEvent(`exception(${exception})`, MockDebugSession.threadID));
			} else {
				this.sendEvent(new StoppedEvent('exception', MockDebugSession.threadID));
			}
		});
		this._runtime.on('breakpointValidated', (bp: IRuntimeBreakpoint) => {
			console.log('breakpointValidated', bp);
			this.sendEvent(new BreakpointEvent('changed', { verified: bp.verified, id: bp.id } as DebugProtocol.Breakpoint));
		});
		this._runtime.on('output', (type, text, filePath, line, column) => {
			console.log('output', type, text, filePath, line, column);
			let category: string;
			switch (type) {
				case 'prio': category = 'important'; break;
				case 'out': category = 'stdout'; break;
				case 'err': category = 'stderr'; break;
				default: category = 'console'; break;
			}
			const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`, category);

			if (text === 'start' || text === 'startCollapsed' || text === 'end') {
				e.body.group = text;
				e.body.output = `group-${text}\n`;
			}

			e.body.source = this.createSource(filePath);
			e.body.line = this.convertDebuggerLineToClient(line);
			e.body.column = this.convertDebuggerColumnToClient(column);
			this.sendEvent(e);
		});
		this._runtime.on('end', () => {
			console.log('end');
			this.sendEvent(new TerminatedEvent());
		});
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		if (args.supportsProgressReporting) {
			this._reportProgress = true;
		}
		if (args.supportsInvalidatedEvent) {
			this._useInvalidatedEvent = true;
		}

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDone request.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

		// make VS Code show a 'step back' button
		// 暂时不支持
		// response.body.supportsStepBack = true;

		// make VS Code support data breakpoints
		// response.body.supportsDataBreakpoints = true;

		// make VS Code support completion in REPL
		response.body.supportsCompletionsRequest = true;
		response.body.completionTriggerCharacters = [".", "["];

		// make VS Code send cancel request
		response.body.supportsCancelRequest = true;

		// make VS Code send the breakpointLocations request
		response.body.supportsBreakpointLocationsRequest = true;

		// make VS Code provide "Step in Target" functionality
		response.body.supportsStepInTargetsRequest = true;

		// the adapter defines two exceptions filters, one with support for conditions.
		response.body.supportsExceptionFilterOptions = true;



		response.body.exceptionBreakpointFilters = [
		];

		// make VS Code send exceptionInfo request
		response.body.supportsExceptionInfoRequest = true;

		// make VS Code send setVariable request
		response.body.supportsSetVariable = true;

		// make VS Code send setExpression request
		response.body.supportsSetExpression = true;

		// make VS Code send disassemble request
		response.body.supportsDisassembleRequest = true;
		response.body.supportsSteppingGranularity = true;
		// response.body.supportsInstructionBreakpoints = true;

		// make VS Code able to read and write variable memory
		response.body.supportsReadMemoryRequest = true;
		response.body.supportsWriteMemoryRequest = true;

		response.body.supportSuspendDebuggee = true;
		response.body.supportTerminateDebuggee = true;
		// response.body.supportsFunctionBreakpoints = true;
		response.body.supportsDelayedStackTraceLoading = true;

		this.sendResponse(response);

		console.log('initializeRequest:', args);
		console.log('initializeResponse:', response);


		this.newRdbProcess();

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	protected newRdbProcess() {
		// 启动ring进程
		// const ringBin = '/Users/lizhenhu/Desktop/Ring/bin/ring';
		const ringRdbBin = 'ring';
		this.ringRdbProcess = spawn(ringRdbBin, ['--interpreter=dap', 'rdb']);

		this.ringRdbProcess.stderr?.on('data', (data) => {
			this.handleRingRdbDapMessage(data.toString());
		});
		this.ringRdbProcess.stdout?.on('data', (data) => {
			console.log('ringRdbStdOutput data:```', data.toString(), '```');
			// 直接给 debug console 展示为 程序的标准输出
			this.sendEvent(new OutputEvent(data.toString(), 'stdout'));
		});
		this.ringRdbProcess.on('close', (code, signal) => {
			console.log('ring-rdb process exited');

			if (code !== 0) {
				this.sendEvent(new OutputEvent(`ring-rdb process exited with code ${code}\n`, 'stderr'));
			} else {
				this.sendEvent(new OutputEvent(`ring-rdb process exited with code ${code}\n`, 'console'));
			}

			this.sendEvent(new TerminatedEvent());
		});
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		console.log('configurationDoneRequest args:', args);
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
		console.log('disconnectRequest args:', args);
		console.log(`disconnectRequest suspend: ${args.suspendDebuggee}, terminate: ${args.terminateDebuggee}`);
	}

	protected async attachRequest(response: DebugProtocol.AttachResponse, args: IAttachRequestArguments) {
		console.log('attachRequest args:', args);
		return this.launchRequest(response, args);
	}

	private showDebugRdbLog(receOrSend: 'receive' | 'send', data: string): void {
		if (!this._showDebugRdbLog) {
			return;
		}
		const title = `${receOrSend} dap message`;
		console.log('<<<<<<<<<<<<<< %s:\n```\n%s\n```\n<<<<<<<<<<<<<<', title, data);
	}

	// 处理 ring 程序的 dap 协议 response/event
	private handleRingRdbDapMessage(data: string): void {
		const lines: string[] = data.split('\n');

		for (const line of lines) {
			if (line.length > 0) {
				this.showDebugRdbLog('receive', line);
				this.handleRingRdbDapOneMessage(line);
			}
		}
	}
	private handleRingRdbDapOneMessage(data: string): void {

		const ringMessage: DebugProtocol.Response = JSON.parse(data);
		if (ringMessage.type === 'event') {
			const ringEvent: DebugProtocol.Event = JSON.parse(data);

			console.log('<<<<<< receive/proxy event `%s` to ui', ringEvent.event);

			if (ringEvent.event === 'terminated') {
				const event: DebugProtocol.TerminatedEvent = JSON.parse(data);
				event.seq = 0;
				this.sendEvent(event);

				console.log("TerminatedEvent:", event);
			} else if (ringEvent.event === 'exited') {
				const event: DebugProtocol.ExitedEvent = JSON.parse(data);
				event.seq = 0;
				this.sendEvent(event);

				console.log("ExitedEvent:", event);

				if (event.body.exitCode !== 0) {
					this.sendEvent(new OutputEvent(`ring process exited with code ${event.body.exitCode}\n`, 'stderr'));
				} else {
					this.sendEvent(new OutputEvent(`ring process exited with code ${event.body.exitCode}\n`, 'console'));
				}
	
				this.sendEvent(new TerminatedEvent());

			} else if (ringEvent.event === 'stopped') {
				const event: DebugProtocol.StoppedEvent = JSON.parse(data);
				event.seq = 0;
				this.sendEvent(event);

				console.log("StoppedEvent:", event);
			}



		} else if (ringMessage.type === 'response') {

			console.log('<<<<<< receive/proxy response `%s` to ui', ringMessage.command);

			if (ringMessage.command === 'launch') {
				const launchResponse: DebugProtocol.LaunchResponse = JSON.parse(data);
				launchResponse.seq = 0;
				this.sendResponse(launchResponse);

				console.log("launchResponse:", launchResponse);
			} else if (ringMessage.command === 'threads') {
				const threadsResponse: DebugProtocol.ThreadsResponse = JSON.parse(data);
				threadsResponse.seq = 0;
				this.sendResponse(threadsResponse);

				console.log("threadsResponse:", threadsResponse);
			} else if (ringMessage.command === 'stackTrace') {
				const stackTraceResponse: DebugProtocol.StackTraceResponse = JSON.parse(data);
				stackTraceResponse.seq = 0;
				this.sendResponse(stackTraceResponse);

				console.log("stackTraceResponse:", stackTraceResponse);
			} else if (ringMessage.command === 'scopes') {
				const scopesResponse: DebugProtocol.ScopesResponse = JSON.parse(data);
				scopesResponse.seq = 0;
				this.sendResponse(scopesResponse);

				console.log("scopesResponse:", scopesResponse);
			} else if (ringMessage.command === 'variables') {
				const variablesResponse: DebugProtocol.VariablesResponse = JSON.parse(data);
				variablesResponse.seq = 0;
				this.sendResponse(variablesResponse);

				console.log("variablesResponse:", variablesResponse);
			} else if (ringMessage.command === 'setBreakpoints') {
				const setBreakpointsResponse: DebugProtocol.SetBreakpointsResponse = JSON.parse(data);
				setBreakpointsResponse.seq = 0;
				this.sendResponse(setBreakpointsResponse);

				console.log("setBreakpointsResponse:", setBreakpointsResponse);
			} else if (ringMessage.command === 'continue') {
				const continueResponse: DebugProtocol.ContinueResponse = JSON.parse(data);
				continueResponse.seq = 0;
				this.sendResponse(continueResponse);

				console.log("continueResponse:", continueResponse);
			} else if (ringMessage.command === 'next') {
				const nextResponse: DebugProtocol.NextResponse = JSON.parse(data);
				nextResponse.seq = 0;
				this.sendResponse(nextResponse);

				console.log("nextResponse:", nextResponse);
			} else if (ringMessage.command === 'stepIn') {
				const stepInResponse: DebugProtocol.StepInResponse = JSON.parse(data);
				stepInResponse.seq = 0;
				this.sendResponse(stepInResponse);

				console.log("stepInResponse:", stepInResponse);
			} else if (ringMessage.command === 'stepOut') {
				const stepOutResponse: DebugProtocol.StepOutResponse = JSON.parse(data);
				stepOutResponse.seq = 0;
				this.sendResponse(stepOutResponse);

				console.log("stepOutResponse:", stepOutResponse);
			}
		}

	}
	// 发送 ring 程序的 dap 协议消息 request
	private sendRingRdbDapMessage(message: any): void {
		const data = JSON.stringify(message);

		this.showDebugRdbLog('send', data);

		this.ringRdbProcess?.stdin?.write(data + '\n');
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
		console.log('launchRequest args:', args);

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		// this.sendEvent(new OutputEvent("launchRequest\n", 'console'));

		// 手动 configurationDone 之后再启动 ring 进程
		await this._configurationDone.wait(10000);

		console.log('launchRequest start ring process....');


		const launchRequest: DebugProtocol.LaunchRequest = {
			type: 'request',
			seq: response.request_seq,
			command: 'launch',
			arguments: args,
		};
		this.sendRingRdbDapMessage(launchRequest);


		// ring 进程成功拉起
		this._launchDone.notify();

		this.sendEvent(new OutputEvent("start ring-rdb process success\n", 'console'));



	}

	protected setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments, request?: DebugProtocol.Request): void {
		console.log('setFunctionBreakPointsRequest args:', args);
		this.sendResponse(response);
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
		console.log('setBreakPointsRequest args:', args);

		const setBreakpointsRequest: DebugProtocol.SetBreakpointsRequest = {
			type: 'request',
			seq: response.request_seq,
			command: 'setBreakpoints',
			arguments: args
		};

		this.sendRingRdbDapMessage(setBreakpointsRequest);
		return;

	}

	protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {
		console.log('breakpointLocationsRequest args:', args);

		if (args.source.path) {
			const bps = this._runtime.getBreakpoints(args.source.path, this.convertClientLineToDebugger(args.line));
			response.body = {
				breakpoints: bps.map(col => {
					return {
						line: args.line,
						column: this.convertDebuggerColumnToClient(col)
					};
				})
			};
		} else {
			response.body = {
				breakpoints: []
			};
		}
		this.sendResponse(response);
	}

	protected async setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments): Promise<void> {
		console.log('setExceptionBreakPointsRequest args:', args);

		let namedException: string | undefined = undefined;
		let otherExceptions = false;

		if (args.filterOptions) {
			for (const filterOption of args.filterOptions) {
				switch (filterOption.filterId) {
					case 'namedException':
						namedException = args.filterOptions[0].condition;
						break;
					case 'otherExceptions':
						otherExceptions = true;
						break;
				}
			}
		}

		if (args.filters) {
			if (args.filters.indexOf('otherExceptions') >= 0) {
				otherExceptions = true;
			}
		}

		this._runtime.setExceptionsFilters(namedException, otherExceptions);

		this.sendResponse(response);
	}

	protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments) {
		console.log('exceptionInfoRequest args:', args);
		response.body = {
			exceptionId: 'Exception ID',
			description: 'This is a descriptive description of the exception.',
			breakMode: 'always',
			details: {
				message: 'Message contained in the exception.',
				typeName: 'Short type name of the exception object',
				stackTrace: 'stack frame 1\nstack frame 2',
			}
		};
		this.sendResponse(response);
	}

	protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {

		console.log('threadsRequest');
		const threadsRequest: DebugProtocol.ThreadsRequest = {
			type: 'request',
			seq: response.request_seq,
			command: 'threads'
		};

		this.sendRingRdbDapMessage(threadsRequest);
		return;

	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

		console.log("stackTraceRequest args:", args);


		const stackTraceRequest: DebugProtocol.StackTraceRequest = {
			type: 'request',
			seq: response.request_seq,
			command: 'stackTrace',
			arguments: args,
		};

		this.sendRingRdbDapMessage(stackTraceRequest);
		return;

	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		console.log("scopesRequest args:", args);

		const scopesRequest: DebugProtocol.ScopesRequest = {
			type: 'request',
			seq: response.request_seq,
			command: 'scopes',
			arguments: args,
		};

		this.sendRingRdbDapMessage(scopesRequest);
		return;

	}

	protected async writeMemoryRequest(response: DebugProtocol.WriteMemoryResponse, { data, memoryReference, offset = 0 }: DebugProtocol.WriteMemoryArguments) {
		console.log("writeMemoryRequest");
		const variable = this._variableHandles.get(Number(memoryReference));
		if (typeof variable === 'object') {
			const decoded = base64.toByteArray(data);
			variable.setMemory(decoded, offset);
			response.body = { bytesWritten: decoded.length };
		} else {
			response.body = { bytesWritten: 0 };
		}

		this.sendResponse(response);
		this.sendEvent(new InvalidatedEvent(['variables']));
	}

	protected async readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, { offset = 0, count, memoryReference }: DebugProtocol.ReadMemoryArguments) {
		console.log("readMemoryRequest");

		const variable = this._variableHandles.get(Number(memoryReference));
		if (typeof variable === 'object' && variable.memory) {
			const memory = variable.memory.subarray(
				Math.min(offset, variable.memory.length),
				Math.min(offset + count, variable.memory.length),
			);

			response.body = {
				address: offset.toString(),
				data: base64.fromByteArray(memory),
				unreadableBytes: count - memory.length
			};
		} else {
			response.body = {
				address: offset.toString(),
				data: '',
				unreadableBytes: count
			};
		}

		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {

		console.log("variablesRequest args:", args);

		const variablesRequest: DebugProtocol.VariablesRequest = {
			type: 'request',
			seq: response.request_seq,
			command: 'variables',
			arguments: args,
		};

		this.sendRingRdbDapMessage(variablesRequest);
		return;

	}

	protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {
		console.log("setVariableRequest args:", args);
		const container = this._variableHandles.get(args.variablesReference);
		const rv = container === 'locals'
			? this._runtime.getLocalVariable(args.name)
			: container instanceof RuntimeVariable && container.value instanceof Array
				? container.value.find(v => v.name === args.name)
				: undefined;

		if (rv) {
			rv.value = this.convertToRuntime(args.value);
			response.body = this.convertFromRuntime(rv);

			if (rv.memory && rv.reference) {
				this.sendEvent(new MemoryEvent(String(rv.reference), 0, rv.memory.length));
			}
		}

		this.sendResponse(response);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		console.log("continueRequest args:", args);

		const continueRequest: DebugProtocol.ContinueRequest = {
			type: 'request',
			seq: response.request_seq,
			command: 'continue',
			arguments: args
		};

		this.sendRingRdbDapMessage(continueRequest);
		return;
	}

	protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments): void {
		console.log("reverseContinueRequest args:", args);
		this._runtime.continue(true);
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		console.log("nextRequest args:", args);

		const nextRequest: DebugProtocol.NextRequest = {
			type: 'request',
			seq: response.request_seq,
			command: 'next',
			arguments: args
		};

		this.sendRingRdbDapMessage(nextRequest);
		return;
	}

	protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
		console.log("stepBackRequest args:", args);
		this._runtime.step(args.granularity === 'instruction', true);
		this.sendResponse(response);
	}

	protected stepInTargetsRequest(response: DebugProtocol.StepInTargetsResponse, args: DebugProtocol.StepInTargetsArguments) {
		console.log("stepInTargetsRequest args:", args);
		const targets = this._runtime.getStepInTargets(args.frameId);
		response.body = {
			targets: targets.map(t => {
				return { id: t.id, label: t.label };
			})
		};
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		console.log("stepInRequest args:", args);

		const stepInRequest: DebugProtocol.StepInRequest = {
			type: 'request',
			seq: response.request_seq,
			command: 'stepIn',
			arguments: args
		};

		this.sendRingRdbDapMessage(stepInRequest);
		return;
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		console.log("stepOutRequest args:", args);

		const stepOutRequest: DebugProtocol.StepOutRequest = {
			type: 'request',
			seq: response.request_seq,
			command: 'stepOut',
			arguments: args
		};

		this.sendRingRdbDapMessage(stepOutRequest);
		return;
	}

	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
		console.log("evaluateRequest args:", args);

		let reply: string | undefined;
		let rv: RuntimeVariable | undefined;

		switch (args.context) {
			case 'repl':
				// handle some REPL commands:
				// 'evaluate' supports to create and delete breakpoints from the 'repl':
				const matches = /new +([0-9]+)/.exec(args.expression);
				if (matches && matches.length === 2) {
					const mbp = await this._runtime.setBreakPoint(this._runtime.sourceFile, this.convertClientLineToDebugger(parseInt(matches[1])));
					const bp = new Breakpoint(mbp.verified, this.convertDebuggerLineToClient(mbp.line), undefined, this.createSource(this._runtime.sourceFile)) as DebugProtocol.Breakpoint;
					bp.id = mbp.id;
					this.sendEvent(new BreakpointEvent('new', bp));
					reply = `breakpoint created`;
				} else {
					const matches = /del +([0-9]+)/.exec(args.expression);
					if (matches && matches.length === 2) {
						const mbp = this._runtime.clearBreakPoint(this._runtime.sourceFile, this.convertClientLineToDebugger(parseInt(matches[1])));
						if (mbp) {
							const bp = new Breakpoint(false) as DebugProtocol.Breakpoint;
							bp.id = mbp.id;
							this.sendEvent(new BreakpointEvent('removed', bp));
							reply = `breakpoint deleted`;
						}
					} else {
						const matches = /progress/.exec(args.expression);
						if (matches && matches.length === 1) {
							if (this._reportProgress) {
								reply = `progress started`;
								this.progressSequence();
							} else {
								reply = `frontend doesn't support progress (capability 'supportsProgressReporting' not set)`;
							}
						}
					}
				}
			// fall through

			default:
				if (args.expression.startsWith('$')) {
					rv = this._runtime.getLocalVariable(args.expression.substr(1));
				} else {
					rv = new RuntimeVariable('eval', this.convertToRuntime(args.expression));
				}
				break;
		}

		if (rv) {
			const v = this.convertFromRuntime(rv);
			response.body = {
				result: v.value,
				type: v.type,
				variablesReference: v.variablesReference,
				presentationHint: v.presentationHint
			};
		} else {
			response.body = {
				result: reply ? reply : `evaluate(context: '${args.context}', '${args.expression}')`,
				variablesReference: 0
			};
		}

		this.sendResponse(response);
	}

	protected setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments): void {
		console.log('setExpressionRequest', args);

		if (args.expression.startsWith('$')) {
			const rv = this._runtime.getLocalVariable(args.expression.substr(1));
			if (rv) {
				rv.value = this.convertToRuntime(args.value);
				response.body = this.convertFromRuntime(rv);
				this.sendResponse(response);
			} else {
				this.sendErrorResponse(response, {
					id: 1002,
					format: `variable '{lexpr}' not found`,
					variables: { lexpr: args.expression },
					showUser: true
				});
			}
		} else {
			this.sendErrorResponse(response, {
				id: 1003,
				format: `'{lexpr}' not an assignable expression`,
				variables: { lexpr: args.expression },
				showUser: true
			});
		}
	}

	private async progressSequence() {

		const ID = '' + this._progressId++;

		await timeout(100);

		const title = this._isProgressCancellable ? 'Cancellable operation' : 'Long running operation';
		const startEvent: DebugProtocol.ProgressStartEvent = new ProgressStartEvent(ID, title);
		startEvent.body.cancellable = this._isProgressCancellable;
		this._isProgressCancellable = !this._isProgressCancellable;
		this.sendEvent(startEvent);
		this.sendEvent(new OutputEvent(`start progress: ${ID}\n`));

		let endMessage = 'progress ended';

		for (let i = 0; i < 100; i++) {
			await timeout(500);
			this.sendEvent(new ProgressUpdateEvent(ID, `progress: ${i}`));
			if (this._cancelledProgressId === ID) {
				endMessage = 'progress cancelled';
				this._cancelledProgressId = undefined;
				this.sendEvent(new OutputEvent(`cancel progress: ${ID}\n`));
				break;
			}
		}
		this.sendEvent(new ProgressEndEvent(ID, endMessage));
		this.sendEvent(new OutputEvent(`end progress: ${ID}\n`));

		this._cancelledProgressId = undefined;
	}

	protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): void {
		console.log("dataBreakpointInfoRequest args:", args);

		response.body = {
			dataId: null,
			description: "cannot break on data access",
			accessTypes: undefined,
			canPersist: false
		};

		if (args.variablesReference && args.name) {
			const v = this._variableHandles.get(args.variablesReference);
			if (v === 'globals') {
				response.body.dataId = args.name;
				response.body.description = args.name;
				response.body.accessTypes = ["write"];
				response.body.canPersist = true;
			} else {
				response.body.dataId = args.name;
				response.body.description = args.name;
				response.body.accessTypes = ["read", "write", "readWrite"];
				response.body.canPersist = true;
			}
		}

		this.sendResponse(response);
	}

	protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): void {
		console.log("setDataBreakpointsRequest args:", args);

		// clear all data breakpoints
		this._runtime.clearAllDataBreakpoints();

		response.body = {
			breakpoints: []
		};

		for (const dbp of args.breakpoints) {
			const ok = this._runtime.setDataBreakpoint(dbp.dataId, dbp.accessType || 'write');
			response.body.breakpoints.push({
				verified: ok
			});
		}

		this.sendResponse(response);
	}

	protected completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments): void {

		console.log("completionsRequest args:", args);

		response.body = {
			targets: [
				{
					label: "item 10",
					sortText: "10"
				},
				{
					label: "item 1",
					sortText: "01",
					detail: "detail 1"
				},
				{
					label: "item 2",
					sortText: "02",
					detail: "detail 2"
				},
				{
					label: "array[]",
					selectionStart: 6,
					sortText: "03"
				},
				{
					label: "func(arg)",
					selectionStart: 5,
					selectionLength: 3,
					sortText: "04"
				}
			]
		};
		this.sendResponse(response);
	}

	protected cancelRequest(response: DebugProtocol.CancelResponse, args: DebugProtocol.CancelArguments) {
		console.log("cancelRequest args:", args);
		if (args.requestId) {
			this._cancellationTokens.set(args.requestId, true);
		}
		if (args.progressId) {
			this._cancelledProgressId = args.progressId;
		}
	}

	protected disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments) {
		console.log("disassembleRequest args:", args);
		const memoryInt = args.memoryReference.slice(3);
		const baseAddress = parseInt(memoryInt);
		const offset = args.instructionOffset || 0;
		const count = args.instructionCount;

		const isHex = memoryInt.startsWith('0x');
		const pad = isHex ? memoryInt.length - 2 : memoryInt.length;

		const loc = this.createSource(this._runtime.sourceFile);

		let lastLine = -1;

		const instructions = this._runtime.disassemble(baseAddress + offset, count).map(instruction => {
			let address = Math.abs(instruction.address).toString(isHex ? 16 : 10).padStart(pad, '0');
			const sign = instruction.address < 0 ? '-' : '';
			const instr: DebugProtocol.DisassembledInstruction = {
				address: sign + (isHex ? `0x${address}` : `${address}`),
				instruction: instruction.instruction
			};
			// if instruction's source starts on a new line add the source to instruction
			if (instruction.line !== undefined && lastLine !== instruction.line) {
				lastLine = instruction.line;
				instr.location = loc;
				instr.line = this.convertDebuggerLineToClient(instruction.line);
			}
			return instr;
		});

		response.body = {
			instructions: instructions
		};
		this.sendResponse(response);
	}

	protected setInstructionBreakpointsRequest(response: DebugProtocol.SetInstructionBreakpointsResponse, args: DebugProtocol.SetInstructionBreakpointsArguments) {
		console.log("setInstructionBreakpointsRequest args:", args);

		// clear all instruction breakpoints
		this._runtime.clearInstructionBreakpoints();

		// set instruction breakpoints
		const breakpoints = args.breakpoints.map(ibp => {
			const address = parseInt(ibp.instructionReference.slice(3));
			const offset = ibp.offset || 0;
			return <DebugProtocol.Breakpoint>{
				verified: this._runtime.setInstructionBreakpoint(address + offset)
			};
		});

		response.body = {
			breakpoints: breakpoints
		};
		this.sendResponse(response);
	}

	protected customRequest(command: string, response: DebugProtocol.Response, args: any) {
		console.log("customRequest command:", command, "args:", args);
		if (command === 'toggleFormatting') {
			this._valuesInHex = !this._valuesInHex;
			if (this._useInvalidatedEvent) {
				this.sendEvent(new InvalidatedEvent(['variables']));
			}
			this.sendResponse(response);
		} else {
			super.customRequest(command, response, args);
		}
	}

	//---- helpers

	private convertToRuntime(value: string): IRuntimeVariableType {

		value = value.trim();

		if (value === 'true') {
			return true;
		}
		if (value === 'false') {
			return false;
		}
		if (value[0] === '\'' || value[0] === '"') {
			return value.substr(1, value.length - 2);
		}
		const n = parseFloat(value);
		if (!isNaN(n)) {
			return n;
		}
		return value;
	}

	private convertFromRuntime(v: RuntimeVariable): DebugProtocol.Variable {

		let dapVariable: DebugProtocol.Variable = {
			name: v.name,
			value: '???',
			type: typeof v.value,
			variablesReference: 0,
			evaluateName: '$' + v.name
		};

		if (v.name.indexOf('lazy') >= 0) {
			// a "lazy" variable needs an additional click to retrieve its value

			dapVariable.value = 'lazy var';		// placeholder value
			v.reference ??= this._variableHandles.create(new RuntimeVariable('', [new RuntimeVariable('', v.value)]));
			dapVariable.variablesReference = v.reference;
			dapVariable.presentationHint = { lazy: true };
		} else {

			if (Array.isArray(v.value)) {
				dapVariable.value = 'Object';
				v.reference ??= this._variableHandles.create(v);
				dapVariable.variablesReference = v.reference;
			} else {

				switch (typeof v.value) {
					case 'number':
						if (Math.round(v.value) === v.value) {
							dapVariable.value = this.formatNumber(v.value);
							(<any>dapVariable).__vscodeVariableMenuContext = 'simple';	// enable context menu contribution
							dapVariable.type = 'integer';
						} else {
							dapVariable.value = v.value.toString();
							dapVariable.type = 'float';
						}
						break;
					case 'string':
						dapVariable.value = `"${v.value}"`;
						break;
					case 'boolean':
						dapVariable.value = v.value ? 'true' : 'false';
						break;
					default:
						dapVariable.value = typeof v.value;
						break;
				}
			}
		}

		if (v.memory) {
			v.reference ??= this._variableHandles.create(v);
			dapVariable.memoryReference = String(v.reference);
		}

		return dapVariable;
	}


	private formatNumber(x: number) {
		return this._valuesInHex ? '0x' + x.toString(16) : x.toString(10);
	}

	private createSource(filePath: string): Source {
		return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'mock-adapter-data');
	}
}

