import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

/** Tiny hash router: every sidebar item is its own page, in the same tab, with working back/forward. */
const read = () => window.location.hash.replace(/^#/, "") || "/";

export function usePath(): string {
  const [path, setPath] = useState(read);
  useEffect(() => {
    const on = () => { setPath(read()); window.scrollTo({ top: 0 }); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return path;
}

export const go = (to: string) => { window.location.hash = to; };

export function Link({ to, className, style, title, children }: {
  to: string; className?: string; style?: CSSProperties; title?: string; children: ReactNode;
}) {
  return <a href={`#${to}`} className={className} style={style} title={title}>{children}</a>;
}
