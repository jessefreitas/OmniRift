import { createContext, useContext } from "react";

// Sinal somente de VIEW: sessões continuam backend-owned quando o floor fica oculto.
// Context evita copiar `active` para o data de cada node (o que trocaria todas as refs
// e re-renderizaria todos os cards a cada frame de drag).
export const FloorActivityContext = createContext(true);

export function useFloorActive(): boolean {
  return useContext(FloorActivityContext);
}
