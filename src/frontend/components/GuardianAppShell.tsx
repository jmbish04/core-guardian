/**
 * @fileoverview App-wide ReUI sidebar shell (adapted from @reui/app-shell-1).
 *
 * Replaces the old thin top navbar. A collapsible ReUI `Sidebar` carries the
 * app's real nav (siteConfig navItems + navGroups) with the current route
 * highlighted; the page content renders in the `SidebarInset` beside it. Wraps
 * every page via BaseLayout — the page's own React islands are slotted through
 * as `children` and hydrate independently.
 *
 * The demo block's workspace-switcher / pinned-resources / teams user-menu are
 * intentionally dropped: this app has none of those concepts. Theme toggling
 * reuses the existing `<ThemeToggle>` (class-based) rather than the block's
 * next-themes dependency.
 */

"use client";

import {
  BookOpenIcon,
  ExternalLinkIcon,
  LayoutDashboardIcon,
  SettingsIcon,
  ShieldIcon,
} from "lucide-react";

import { ThemeToggle } from "@/components/ThemeToggle";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { siteConfig, type NavItem } from "@/lib/config";
import { cn } from "@/lib/utils";

const GROUP_ICON: Record<string, typeof BookOpenIcon> = {
  Dashboards: LayoutDashboardIcon,
  Docs: BookOpenIcon,
  System: SettingsIcon,
};

/** Exact match, or a prefix match for nested routes (but never the bare root). */
function isActive(pathname: string, href: string): boolean {
  if (href === pathname) return true;
  if (href.length > 1 && href.startsWith("/dashboard") && pathname.startsWith(href + "/")) return true;
  return false;
}

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = isActive(pathname, item.href);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        tooltip={item.label}
        render={
          <a
            href={item.href}
            {...(item.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          >
            <span className="truncate">{item.label}</span>
            {item.external ? <ExternalLinkIcon className="ml-auto size-3 opacity-50" /> : null}
          </a>
        }
      />
    </SidebarMenuItem>
  );
}

export function GuardianAppShell({
  pathname,
  title,
  children,
}: {
  pathname: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <SidebarProvider>
      <Sidebar collapsible="offcanvas">
        <SidebarHeader>
          <a href="/dashboard/guardian" className="flex items-center gap-2 px-2 py-1.5">
            <ShieldIcon className="size-5 text-primary" aria-hidden />
            <span className="text-sm font-semibold tracking-tight">{siteConfig.name}</span>
          </a>
        </SidebarHeader>

        <SidebarContent>
          {/* Top-level items (Guardian). */}
          <SidebarGroup>
            <SidebarMenu>
              {siteConfig.navItems.map((item) => (
                <NavLink key={item.href} item={item} pathname={pathname} />
              ))}
            </SidebarMenu>
          </SidebarGroup>

          {/* Grouped destinations. */}
          {siteConfig.navGroups.map((group) => {
            const Icon = GROUP_ICON[group.label];
            return (
              <SidebarGroup key={group.label}>
                <SidebarGroupLabel className="flex items-center gap-1.5">
                  {Icon ? <Icon className="size-3.5" aria-hidden /> : null}
                  {group.label}
                </SidebarGroupLabel>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <NavLink key={item.href} item={item} pathname={pathname} />
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            );
          })}
        </SidebarContent>

        <SidebarFooter>
          <div className="flex items-center justify-between gap-2 px-2 py-1">
            <span className="truncate text-xs text-muted-foreground">Spend governance</span>
            <ThemeToggle />
          </div>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        {/* Slim sticky header: sidebar toggle + page title. */}
        <header
          className={cn(
            "sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 bg-background/80 px-4 backdrop-blur",
            "ring-1 ring-inset ring-border/30",
          )}
        >
          <SidebarTrigger className="-ml-1" />
          {title ? <span className="text-sm font-medium tracking-tight">{title}</span> : null}
        </header>
        <div className="flex flex-1 flex-col">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
