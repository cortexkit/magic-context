import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { ask as tauriAsk, message as tauriMessage } from "@tauri-apps/plugin-dialog";
import { relaunch as tauriRelaunch } from "@tauri-apps/plugin-process";
import { check as tauriCheck } from "@tauri-apps/plugin-updater";

export type TauriUpdate = NonNullable<Awaited<ReturnType<typeof tauriCheck>>>;

type TauriEvent<T> = {
  event: string;
  id: number;
  payload: T;
};

type AskOptions = Parameters<typeof tauriAsk>[1];
type MessageOptions = Parameters<typeof tauriMessage>[1];

let token: string | null = null;

export const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as Window & object);

export function initServeToken() {
  if (typeof window === "undefined") return;
  const hash = window.location.hash;
  const match = /[#&]token=([^&]+)/.exec(hash);
  if (!match) return;
  token = decodeURIComponent(match[1]);
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) return tauriInvoke<T>(cmd, args);
  const response = await fetch("/api/invoke", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ cmd, args: args ?? {} }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (body?.error && typeof body.error === "object") throw body.error;
    throw new Error(body?.error ?? `HTTP ${response.status}`);
  }
  return body as T;
}

export async function ask(message: string, options?: AskOptions): Promise<boolean> {
  if (isTauri()) return tauriAsk(message, options);
  return window.confirm(message);
}

export async function notify(message: string, options?: MessageOptions): Promise<void> {
  if (isTauri()) await tauriMessage(message, options);
  else window.alert(message);
}

export function listen<T>(
  event: string,
  handler: (event: TauriEvent<T>) => void,
): Promise<() => void> {
  if (isTauri()) return tauriListen<T>(event, handler);
  return Promise.resolve(() => {});
}

export async function checkTauriUpdate(): Promise<TauriUpdate | null> {
  if (!isTauri()) return null;
  return tauriCheck();
}

export async function relaunch(): Promise<void> {
  if (isTauri()) await tauriRelaunch();
}

export function __resetServeTokenForTests() {
  token = null;
}
