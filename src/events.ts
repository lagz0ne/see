// In-memory pub/sub event bus keyed by upload id.
// Note: multi-instance deployments would need a shared bus (e.g. Redis pub/sub).

type Listener = (data: unknown) => void;

class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(id: string, listener: Listener): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      const s = this.listeners.get(id);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) {
        this.listeners.delete(id);
      }
    };
  }

  emit(id: string, data: unknown): void {
    const set = this.listeners.get(id);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(data);
      } catch {
        // swallow listener errors
      }
    }
  }
}

export const eventBus = new EventBus();
