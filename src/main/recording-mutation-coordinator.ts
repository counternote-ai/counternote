export type RecordingMutationKind = 'capture' | 'recover' | 'trash';

export interface RecordingMutationLease {
  readonly kind: RecordingMutationKind;
  release(): void;
}

/** Serializes every mutation below the recordings root without retaining queued work. */
export class RecordingMutationCoordinator {
  private owner: RecordingMutationKind | undefined;
  private closing = false;
  private drainPromise: Promise<void> | undefined;
  private resolveDrain: (() => void) | undefined;

  public tryAcquire(kind: RecordingMutationKind): RecordingMutationLease | undefined {
    if (this.closing || this.owner !== undefined) return undefined;
    this.owner = kind;
    let released = false;
    return {
      kind,
      release: (): void => {
        if (released) return;
        released = true;
        this.owner = undefined;
        this.resolveDrain?.();
      },
    };
  }

  public closeAndDrain(): Promise<void> {
    this.closing = true;
    if (this.drainPromise === undefined) {
      this.drainPromise =
        this.owner === undefined
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              this.resolveDrain = resolve;
            });
    }
    return this.drainPromise;
  }

  public snapshot(): { owner?: RecordingMutationKind; closing: boolean } {
    return this.owner === undefined
      ? { closing: this.closing }
      : { owner: this.owner, closing: this.closing };
  }
}
