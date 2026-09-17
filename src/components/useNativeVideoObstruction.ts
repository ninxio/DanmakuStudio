import { useLayoutEffect, type RefObject } from "react";
import { registerNativeVideoObstruction } from "../infrastructure/media/nativeVideoLayout";

export function useNativeVideoObstruction(ref: RefObject<HTMLElement>, active = true) {
  useLayoutEffect(() => {
    if (active && ref.current) return registerNativeVideoObstruction(ref.current);
  }, [active, ref]);
}
