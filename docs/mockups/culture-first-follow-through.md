# Culture-first page follow-through

The current public launch flow is ERC-20-only. As each live page joins the culture-first redesign, remove user-facing “pick a base” language and generic base-type lists. Do not advertise ERC-721A or ERC-1155 as choices until they are actually available.

- `web/src/app/page.tsx`: replace the existing “pick a base / erc-20 · 721a · 1155” explainer with “define your coin / name · ticker · art · socials.”
- `web/src/app/create/page.tsx`: remove the visible base-selection surface and disabled NFT choices as part of that page’s redesign, while retaining the existing ERC-20 launch behavior.
- Future catalog, docs, and trade-page passes: avoid “choose a base” and NFT-option copy until the product supports those choices.

This is a redesign follow-through note only; this mockup pass does not change the live routes or underlying multi-base code.
