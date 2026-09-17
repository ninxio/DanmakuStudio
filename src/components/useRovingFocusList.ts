import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent
} from "react";

interface RovingFocusListOptions {
  itemIds: readonly string[];
  preferredId?: string | null;
  onEscape?: () => void;
}

export function useRovingFocusList({
  itemIds,
  preferredId = null,
  onEscape
}: RovingFocusListOptions) {
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const previousItemIdsRef = useRef([...itemIds]);
  const focusedIdRef = useRef<string | null>(null);
  const [tabStopId, setTabStopId] = useState<string | null>(() =>
    chooseInitialId(itemIds, preferredId)
  );

  useLayoutEffect(() => {
    const previousItemIds = previousItemIdsRef.current;
    previousItemIdsRef.current = [...itemIds];
    if (tabStopId && itemIds.includes(tabStopId)) return;

    const referenceId = focusedIdRef.current ?? tabStopId;
    const previousIndex = referenceId ? previousItemIds.indexOf(referenceId) : -1;
    const nextId =
      (preferredId && itemIds.includes(preferredId) ? preferredId : null) ??
      itemIds[Math.min(Math.max(previousIndex, 0), Math.max(itemIds.length - 1, 0))] ??
      null;
    setTabStopId(nextId);

    if (focusedIdRef.current && nextId) {
      focusedIdRef.current = nextId;
      itemRefs.current.get(nextId)?.focus();
    }
  }, [itemIds, preferredId, tabStopId]);

  const setItemRef = useCallback((id: string, element: HTMLElement | null) => {
    if (element) itemRefs.current.set(id, element);
    else itemRefs.current.delete(id);
  }, []);

  const onItemFocus = useCallback((id: string) => {
    focusedIdRef.current = id;
    setTabStopId(id);
  }, []);

  const onItemKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>, id: string) => {
      if (event.key === "Escape") {
        event.preventDefault();
        focusedIdRef.current = null;
        onEscape?.();
        return;
      }

      const currentIndex = itemIds.indexOf(id);
      if (currentIndex < 0) return;
      const nextIndex = keyboardTargetIndex(event.key, currentIndex, itemIds.length);
      if (nextIndex === null) return;

      event.preventDefault();
      const nextId = itemIds[nextIndex];
      if (!nextId) return;
      focusedIdRef.current = nextId;
      setTabStopId(nextId);
      itemRefs.current.get(nextId)?.focus();
    },
    [itemIds, onEscape]
  );

  return {
    getItemTabIndex: (id: string): 0 | -1 => (id === tabStopId ? 0 : -1),
    setItemRef,
    onItemFocus,
    onItemKeyDown
  };
}

function chooseInitialId(itemIds: readonly string[], preferredId: string | null): string | null {
  if (preferredId && itemIds.includes(preferredId)) return preferredId;
  return itemIds[0] ?? null;
}

function keyboardTargetIndex(
  key: string,
  currentIndex: number,
  itemCount: number
): number | null {
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  if (key === "ArrowDown" || key === "ArrowRight") {
    return Math.min(currentIndex + 1, itemCount - 1);
  }
  if (key === "ArrowUp" || key === "ArrowLeft") {
    return Math.max(currentIndex - 1, 0);
  }
  return null;
}
