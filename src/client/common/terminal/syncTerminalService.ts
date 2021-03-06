// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { inject } from 'inversify';
import * as path from 'path';
import { CancellationToken, Disposable, Event } from 'vscode';
import { EXTENSION_ROOT_DIR } from '../../constants';
import { IInterpreterService, PythonInterpreter } from '../../interpreter/contracts';
import { Cancellation } from '../cancellation';
import { traceVerbose } from '../logger';
import { IFileSystem, TemporaryFile } from '../platform/types';
import { createDeferred, Deferred } from '../utils/async';
import { noop } from '../utils/misc';
import { TerminalService } from './service';
import { ITerminalService } from './types';

const shellExecFile = path.join(EXTENSION_ROOT_DIR, 'pythonFiles', 'shell_exec.py');
enum State {
    notStarted = 0,
    started = 1,
    completed = 2,
    errored = 4
}

class ExecutionState implements Disposable {
    public state: State = State.notStarted;
    private _completed: Deferred<void> = createDeferred();
    private disposable?: Disposable;
    constructor(public readonly lockFile: string, private readonly fs: IFileSystem, private readonly command: string[]) {
        this.registerStateUpdate();
        this._completed.promise.finally(() => this.dispose()).ignoreErrors();
    }
    public get completed(): Promise<void> {
        return this._completed.promise;
    }
    public dispose() {
        if (this.disposable) {
            this.disposable.dispose();
            this.disposable = undefined;
        }
    }
    private registerStateUpdate() {
        const timeout = setInterval(async () => {
            const state = await this.getLockFileState(this.lockFile);
            if (state !== this.state) {
                traceVerbose(`Command state changed to ${state}. ${this.command.join(' ')}`);
            }
            this.state = state;
            if (state & State.errored) {
                this._completed.reject(new Error(`Command failed with errors, check the terminal for details. Command: ${this.command.join(' ')}`));
            } else if (state & State.completed) {
                this._completed.resolve();
            }
        }, 100);

        this.disposable = {
            // tslint:disable-next-line: no-any
            dispose: () => clearInterval(timeout as any)
        };
    }
    private async getLockFileState(file: string): Promise<State> {
        const source = await this.fs.readFile(file);
        let state: State = State.notStarted;
        if (source.includes('START')) {
            state |= State.started;
        }
        if (source.includes('END')) {
            state |= State.completed;
        }
        if (source.includes('FAIL')) {
            state |= State.completed | State.errored;
        }
        return state;
    }
}

/**
 * This is a decorator class that ensures commands send to a terminal are completed and then execution is returned back to calling code.
 * The tecnique used is simple:
 * - Instead of sending actual text to a terminal,
 * - Send text to a terminal that executes our python file, passing in the original text as args
 * - The pthon file will execute the commands as a subprocess
 * - At the end of the execution a file is created to singal completion.
 *
 * @export
 * @class SynchronousTerminalService
 * @implements {ITerminalService}
 * @implements {Disposable}
 */
export class SynchronousTerminalService implements ITerminalService, Disposable {
    private readonly disposables: Disposable[] = [];
    public get onDidCloseTerminal(): Event<void> {
        return this.terminalService.onDidCloseTerminal;
    }
    constructor(
        @inject(IFileSystem) private readonly fs: IFileSystem,
        @inject(IInterpreterService) private readonly interpreter: IInterpreterService,
        public readonly terminalService: TerminalService,
        private readonly pythonInterpreter?: PythonInterpreter
    ) {}
    public dispose() {
        this.terminalService.dispose();
        while (this.disposables.length) {
            const disposable = this.disposables.shift();
            if (disposable) {
                try {
                    disposable.dispose();
                } catch {
                    noop();
                }
            } else {
                break;
            }
        }
    }
    public async sendCommand(command: string, args: string[], cancel?: CancellationToken): Promise<void> {
        if (!cancel) {
            return this.terminalService.sendCommand(command, args);
        }
        const lockFile = await this.createLockFile();
        const state = new ExecutionState(lockFile.filePath, this.fs, [command, ...args]);
        try {
            const pythonExec = this.pythonInterpreter || (await this.interpreter.getActiveInterpreter(undefined));
            await this.terminalService.sendCommand(pythonExec?.path || 'python', [
                shellExecFile.fileToCommandArgument(),
                command.fileToCommandArgument(),
                ...args,
                lockFile.filePath.fileToCommandArgument()
            ]);
            await Cancellation.race(() => state.completed.catch(noop), cancel);
        } finally {
            state.dispose();
            lockFile.dispose();
        }
    }
    public sendText(text: string): Promise<void> {
        return this.terminalService.sendText(text);
    }
    public show(preserveFocus?: boolean | undefined): Promise<void> {
        return this.terminalService.show(preserveFocus);
    }

    private createLockFile(): Promise<TemporaryFile> {
        return this.fs.createTemporaryFile('.log').then(l => {
            this.disposables.push(l);
            return l;
        });
    }
}
