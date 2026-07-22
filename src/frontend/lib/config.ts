export type NavItem = {
  href: string;
  label: string;
  external?: boolean;
};

export type NavGroup = {
  label: string;
  items: NavItem[];
};

export type SiteConfig = {
  name: string;
  description: string;
  url: string;
  author: {
    name: string;
    url: string;
  };
  links: {
    github: string;
  };
  /** Primary top-level links shown directly in the navbar. */
  navItems: NavItem[];
  /** Grouped destinations rendered as dropdown menus (desktop) / sections (mobile). */
  navGroups: NavGroup[];
};

export const siteConfig: SiteConfig = {
  name: "Core Guardian",
  description:
    "Cloudflare spend-governance cockpit — monitors usage across every binding, projects month-end cost against included allowances, and halts runaway spend.",
  url: "https://core-guardian.hacolby.workers.dev",
  author: {
    name: "Author",
    url: "https://example.com",
  },
  links: {
    github: "https://github.com",
  },
  // Core Guardian is a spend-governance tool, not the demo template it was
  // staged from. The template's Workspace/Agents showcase pages still exist on
  // disk (reachable by direct URL, kept for future reuse — e.g. wiring up the
  // chat agents later) but are intentionally NOT surfaced in the navbar; see
  // .agent/rules/startup.md. Only routes that exist and belong to the product
  // are linked. Dead links (e.g. /health before it ships in P7) are added when
  // the page lands, never before.
  navItems: [
    { href: "/dashboard/guardian", label: "Guardian" },
  ],
  navGroups: [
    {
      label: "Dashboards",
      items: [
        { href: "/dashboard/guardian", label: "Core Guardian" },
        { href: "/dashboard/action-items", label: "Action Items" },
        { href: "/dashboard/storage", label: "Data Storage" },
        { href: "/dashboard/ai-gateway", label: "AI Gateway Billing" },
        { href: "/dashboard/cost-basis", label: "Cost Basis" },
        { href: "/dashboard/drive-config", label: "Drive Folders" },
        { href: "/dashboard/alerts", label: "Alert Rules" },
        { href: "/dashboard/notifications-inbox", label: "Alert Inbox" },
      ],
    },
    {
      label: "Docs",
      items: [
        { href: "/docs", label: "Overview" },
        { href: "/docs/architecture", label: "Architecture" },
        { href: "/changelogs", label: "Changelog" },
        { href: "/changelogs/preview", label: "Roadmap" },
        { href: "/openapi.json", label: "OpenAPI" },
        { href: "/scalar", label: "Scalar" },
        { href: "/swagger", label: "Swagger" },
      ],
    },
    {
      label: "System",
      items: [
        { href: "/health", label: "Health" },
        { href: "/login", label: "Sign in" },
        { href: "/settings", label: "Settings" },
      ],
    },
  ],
};
