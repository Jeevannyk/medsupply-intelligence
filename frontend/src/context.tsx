import { createContext, useContext } from "react";
import type { Meta, Overview, Scenario, Weights } from "./api";

export type Names = { hn: (id: string) => string; mn: (id: string) => string; unit: (id: string) => string };
export type Act = (fn: () => Promise<unknown>, ok: string | ((r: any) => string)) => Promise<void>;

export interface AppState {
  meta: Meta;
  ov: Overview;
  ovLoading: boolean;
  scenario: Scenario;
  actor: string;
  setActor: (a: string) => void;
  med: string;
  setMed: (m: string) => void;
  hosp: string;
  setHosp: (h: string) => void;
  weights: Weights;
  setWeights: (w: Weights) => void;
  version: number;
  act: Act;
  names: Names;
}

const Ctx = createContext<AppState | null>(null);
export const AppProvider = Ctx.Provider;
export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}
