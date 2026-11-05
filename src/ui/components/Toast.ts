// Short status notes in the bottom corner: undo/redo, autosave restores and
// failures of background work that would otherwise only reach the console.

let host: HTMLElement | null = null;

function container() {
  if (host && host.isConnected) return host;
  host = document.createElement("div");
  host.className = "toasts";
  host.setAttribute("role", "status");
  host.setAttribute("aria-live", "polite");
  document.body.appendChild(host);
  return host;
}

export interface ToastAction {
  label: string;
  run: () => void;
}

export function toast(message: string, opts: { error?: boolean; action?: ToastAction; ms?: number } = {}) {
  const el = document.createElement("div");
  el.className = "toast" + (opts.error ? " error" : "");
  const text = document.createElement("span");
  text.textContent = message;
  el.appendChild(text);
  if (opts.action) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = opts.action.label;
    b.addEventListener("click", () => {
      opts.action!.run();
      dismiss();
    });
    el.appendChild(b);
  }
  const box = container();
  // Keep the stack short; the newest note matters most
  while (box.children.length >= 3) box.firstElementChild!.remove();
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add("in"));
  const dismiss = () => {
    el.classList.remove("in");
    setTimeout(() => el.remove(), 200);
  };
  setTimeout(dismiss, opts.ms ?? (opts.error ? 6000 : opts.action ? 6000 : 2200));
}

// Runs a promise from an event handler without awaiting it, reporting a
// failure to the user instead of letting it vanish as an unhandled rejection.
export function background(work: Promise<unknown>, what: string) {
  work.catch((e: unknown) => {
    console.error(`${what} failed:`, e);
    toast(`${what} failed${e instanceof Error && e.message ? `: ${e.message}` : ""}`, { error: true });
  });
}
