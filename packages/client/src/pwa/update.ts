/** The prompt must appear within 5 s of detecting a new version (Req 21.9). */
export const UPDATE_PROMPT_MAX_DELAY_MS = 5_000;

export interface UpdateState {
  updateAvailable: boolean;
}

/** Minimal subset of ServiceWorkerRegistration used here, so it can be tested without a browser. */
export interface RegistrationLike {
  waiting: { postMessage(message: unknown): void } | null;
  installing: StateSource | null;
  addEventListener(type: "updatefound", listener: () => void): void;
  update?(): Promise<unknown>;
}

interface StateSource {
  state: string;
  addEventListener(type: "statechange", listener: () => void): void;
}

export interface ContainerLike {
  controller: unknown;
  addEventListener(type: "controllerchange", listener: () => void): void;
}

/**
 * Detects a waiting service worker, exposes an `updateAvailable` flag for the prompt, and on
 * confirmation asks the waiting worker to activate and reloads once it takes control (Req 21.9, 21.10).
 */
export class UpdateController {
  private state: UpdateState = { updateAvailable: false };
  private readonly listeners = new Set<() => void>();
  private refreshing = false;

  constructor(
    private readonly registration: RegistrationLike,
    private readonly container: ContainerLike,
    private readonly reload: () => void,
  ) {
    // Only reload when an existing controller is replaced, not on first install.
    const hadController = Boolean(container.controller);
    container.addEventListener("controllerchange", () => {
      if (!hadController || this.refreshing === false) return;
      this.reload();
    });
    if (registration.waiting && hadController) this.setAvailable();
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && container.controller) this.setAvailable();
      });
    });
  }

  getState = (): UpdateState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** User chose "refresh": activate the waiting worker; the page reloads on controllerchange. */
  applyUpdate(): void {
    const waiting = this.registration.waiting;
    if (!waiting) {
      this.reload();
      return;
    }
    this.refreshing = true;
    waiting.postMessage({ type: "SKIP_WAITING" });
  }

  /** Ask the browser to look for a new version now. */
  checkForUpdate(): void {
    void this.registration.update?.().catch(() => undefined);
  }

  private setAvailable(): void {
    if (this.state.updateAvailable) return;
    this.state = { updateAvailable: true };
    for (const l of this.listeners) l();
  }
}
