import { createContext, useContext } from "react";
import type { JSX, ReactNode } from "react";
import { BanditThemeProvider } from "../theme";

export type BanditRuntimeContext = "web" | "vscode";

export interface BanditContextValue {
  context: BanditRuntimeContext;
}

const BanditContext = createContext<BanditContextValue>({ context: "web" });

export const useBanditContext = (): BanditContextValue => useContext(BanditContext);

export interface BanditContextProviderProps {
  context?: BanditRuntimeContext;
  children: ReactNode;
}

export const BanditContextProvider = ({
  context = "web",
  children
}: BanditContextProviderProps): JSX.Element => {
  return <BanditContext.Provider value={{ context }}>{children}</BanditContext.Provider>;
};

export type BanditProviderProps = BanditContextProviderProps;

export const BanditProvider = ({ context = "web", children }: BanditProviderProps): JSX.Element => {
  return (
    <BanditContextProvider context={context}>
      <BanditThemeProvider>{children}</BanditThemeProvider>
    </BanditContextProvider>
  );
};
