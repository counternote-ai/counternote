import { app } from 'electron';

export interface QuitCoordinatorDependencies {
  readonly app: Pick<Electron.App, 'quit' | 'on'>;
  isIdle(): boolean;
  closeAndDrain(): Promise<void>;
  stopCaptureIfActive(): Promise<unknown>;
}

export class QuitCoordinator {
  private quitRequested = false;
  private _allowQuit = false;
  private quitPromise: Promise<void> | undefined;
  private readonly deps: QuitCoordinatorDependencies;

  public constructor(deps: QuitCoordinatorDependencies) {
    this.deps = deps;
  }

  public handleBeforeQuit(event: Electron.Event): void {
    if (this._allowQuit || this.deps.isIdle()) return;
    event.preventDefault();
    if (this.quitPromise === undefined) {
      this.quitRequested = true;
      const drain = this.deps.closeAndDrain();
      const stop = this.deps.stopCaptureIfActive();
      this.quitPromise = Promise.allSettled([stop, drain]).then(() => {
        this._allowQuit = true;
        this.deps.app.quit();
      });
    }
  }

  public isQuitRequested(): boolean {
    return this.quitRequested;
  }

  public get allowQuit(): boolean {
    return this._allowQuit;
  }

  public isFinishing(): boolean {
    return this.quitRequested && !this._allowQuit;
  }
}
