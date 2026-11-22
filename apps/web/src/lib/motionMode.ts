// FILE: motionMode.ts
// Purpose: Resolves whether the UI runs in lite mode (no animations or ambient effects) and
//          mirrors the result on the document root so CSS can switch motion off globally.
// Layer: Web UI motion primitive

import { useEffect, useSyncExternalStore } from "react";

import { useAppSettings, type MotionMode } from "~/appSettings";

export const MOTION_ATTRIBUTE = "data-motion";
export const MOTION_REDUCE_VALUE = "reduce";

export interface MotionEnvironment {
  readonly prefersReducedMotion: boolean;
  readonly hardwareConcurrency: number | undefined;
  readonly deviceMemory: number | undefined;
}

/** Lite when chosen, or in auto mode on a reduced-motion or low-resource machine. */
export function resolveLiteMotion(mode: MotionMode, environment: MotionEnvironment): boolean {
  if (mode === "lite") return true;
  if (mode === "full") return false;
  return (
    environment.prefersReducedMotion ||
    (environment.hardwareConcurrency !== undefined && environment.hardwareConcurrency <= 2) ||
    (environment.deviceMemory ?? 8) <= 4
  );
}

export function readMotionEnvironment(): MotionEnvironment {
  const navigatorWithMemory =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as Navigator & { deviceMemory?: number });
  return {
    prefersReducedMotion:
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    hardwareConcurrency: navigatorWithMemory?.hardwareConcurrency,
    deviceMemory: navigatorWithMemory?.deviceMemory,
  };
}

function subscribeToReducedMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function useLiteMotion(): boolean {
  const { settings } = useAppSettings();
  const prefersReducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    () => readMotionEnvironment().prefersReducedMotion,
    () => false,
  );
  return resolveLiteMotion(settings.motionMode, {
    ...readMotionEnvironment(),
    prefersReducedMotion,
  });
}

/** Mirrors the effective mode on `<html>`; mount once near the root. */
export function useApplyMotionMode(): boolean {
  const lite = useLiteMotion();
  useEffect(() => {
    const root = document.documentElement;
    if (lite) root.setAttribute(MOTION_ATTRIBUTE, MOTION_REDUCE_VALUE);
    else root.removeAttribute(MOTION_ATTRIBUTE);
    return () => root.removeAttribute(MOTION_ATTRIBUTE);
  }, [lite]);
  return lite;
}

export function isLiteMotionApplied(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.getAttribute(MOTION_ATTRIBUTE) === MOTION_REDUCE_VALUE
  );
}
