import { useEffect, useState } from "react";
import type { ThemeTokens } from "@hokago/theme";
import { Wordmark } from "./Wordmark";
import { fetchLibraries, fetchLibraryItems, type LibrarySummary, type MediaCard } from "./browse-api";

interface BrowsePageProps {
  tokens: ThemeTokens;
}

interface Shelf {
  library: LibrarySummary;
  items: MediaCard[];
}

// The real browse grid (§7.6/§15) — poster wall built entirely from the
// active theme's layout tokens, so a theme switch genuinely reshapes the
// page (sidebar vs top nav, poster vs episodic aspect, hover treatment)
// rather than just recoloring it.
export function BrowsePage({ tokens }: BrowsePageProps) {
  const [shelves, setShelves] = useState<Shelf[]>([]);
  const { layout } = tokens;

  useEffect(() => {
    let cancelled = false;
    fetchLibraries().then(async (libraries) => {
      const withItems = await Promise.all(
        libraries.map(async (library) => ({ library, items: await fetchLibraryItems(library.id) })),
      );
      if (!cancelled) setShelves(withItems.filter((s) => s.items.length > 0));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const hero = layout.heroStyle === "none" ? null : shelves.flatMap((s) => s.items).find((i) => i.backdropUrl);

  return (
    <div className="browse-page" data-nav={layout.nav}>
      <nav className="browse-nav" data-nav={layout.nav} data-sticky={layout.navSticky}>
        <Wordmark />
        <div className="browse-nav__links">
          {shelves.map(({ library }) => (
            <a key={library.id} className="browse-nav__link" href={`#lib-${library.id}`}>
              <span className="browse-nav__link-badge">{library.name.charAt(0).toUpperCase()}</span>
              <span className="browse-nav__link-label">{library.name}</span>
            </a>
          ))}
        </div>
        <div className="browse-nav__profile">
          <span className="browse-nav__avatar" aria-hidden="true" />
          <span className="browse-nav__profile-label">Profile</span>
        </div>
      </nav>
      <div className="browse-page__body">
        {hero && (
          <div className="browse-hero">
            {layout.heroStyle === "backdrop" && hero.backdropUrl && (
              <img className="browse-hero__image" src={hero.backdropUrl} alt="" />
            )}
            {layout.heroStyle === "poster" && hero.posterUrl && (
              <img className="browse-hero__image" src={hero.posterUrl} alt="" />
            )}
            <div className="browse-hero__wash" />
            <div className="browse-hero__scrim" />
            <div className="browse-hero__content">
              <h1 className="browse-hero__title">{hero.title}</h1>
              {hero.year && <p className="browse-hero__meta">{hero.year}</p>}
            </div>
          </div>
        )}
        {shelves.map(({ library, items }) => (
          <section className="browse-section" id={`lib-${library.id}`} key={library.id}>
            <h2 className="browse-section__title">{library.name}</h2>
            <div className="browse-grid">
              {items.map((item) => (
                <div
                  className="browse-card"
                  key={item.id}
                  data-hover={layout.cardHover}
                  data-title={layout.cardTitle}
                >
                  {item.posterUrl ? (
                    <img className="browse-card__poster" src={item.posterUrl} alt="" />
                  ) : (
                    <div className="browse-card__placeholder" aria-hidden="true">
                      {item.title.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="browse-card__title">{item.title}</div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
