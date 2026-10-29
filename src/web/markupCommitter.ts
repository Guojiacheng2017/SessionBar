interface MarkupTarget { innerHTML: string; readonly firstChild: object | null }

/** Compare render inputs, allowing controls to change their own DOM between updates. */
export function createMarkupCommitter<T extends MarkupTarget>(
  normalize: (markup: string) => string = markup => markup,
  settled?: (target: T) => void,
): (target: T, markup: string) => boolean {
  const committed = new WeakMap<T, { source: string; root: object | null }>();
  return (target, markup) => {
    const previous = committed.get(target);
    // Another renderer (e.g. the system monitor) may replace this region's root.
    const unchanged = (previous?.source === markup && previous.root === target.firstChild)
      || normalize(target.innerHTML) === markup;
    if (!unchanged) target.innerHTML = markup;
    committed.set(target, { source: markup, root: target.firstChild });
    settled?.(target);
    return !unchanged;
  };
}
