import { useEffect } from "react";

type PageMeta = {
  title: string;
  description: string;
  ogTitle?: string;
  ogDescription?: string;
  noindex?: boolean;
};

function setMeta(name: string, content: string) {
  let el = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("name", name);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function setOgMeta(property: string, content: string) {
  let el = document.querySelector<HTMLMetaElement>(`meta[property="${property}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("property", property);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

export function usePageMeta({ title, description, ogTitle, ogDescription, noindex }: PageMeta) {
  useEffect(() => {
    document.title = title;
    setMeta("description", description);
    setMeta("robots", noindex ? "noindex, nofollow" : "index, follow");
    setOgMeta("og:title", ogTitle ?? title);
    setOgMeta("og:description", ogDescription ?? description);
    // Reset to defaults on unmount so navigating away doesn't leave stale values.
    return () => {
      document.title = "dash Catering by Hollywood East Cafe";
      setMeta("description", "Asian-inspired catering for corporate events, weddings, and private gatherings in Olney, Maryland. Browse the full menu and build your event plan online.");
      setMeta("robots", "index, follow");
      setOgMeta("og:title", "dash Catering by Hollywood East Cafe");
      setOgMeta("og:description", "Asian-inspired catering for corporate events, weddings, and private gatherings in Olney, Maryland. Browse the full menu and build your event plan online.");
    };
  }, [title, description, ogTitle, ogDescription, noindex]);
}
