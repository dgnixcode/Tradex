import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createBrowserRouter, useLocation } from 'react-router-dom';
import { AuthProvider, RequireAuth } from './auth.tsx';
import { BrandingProvider, useBranding } from './branding.tsx';
import { App } from './App.tsx';
import { Landing } from './routes/Landing.tsx';
import { Login } from './routes/Login.tsx';
import { Signup } from './routes/Signup.tsx';
import { ForgotPassword } from './routes/ForgotPassword.tsx';
import { ResetPassword } from './routes/ResetPassword.tsx';
import { About } from './routes/About.tsx';
import { Model } from './routes/Model.tsx';
import { Guarantee } from './routes/Guarantee.tsx';
import { Contact } from './routes/Contact.tsx';
import { FaqPage } from './routes/FaqPage.tsx';
import { TradeTicket } from './routes/TradeTicket.tsx';
import { Confirmation } from './routes/Confirmation.tsx';
import { Execution } from './routes/Execution.tsx';
import { Groups } from './routes/Groups.tsx';
import { GroupDetail } from './routes/GroupDetail.tsx';
import { Accounts } from './routes/Accounts.tsx';
import { Blotter } from './routes/Blotter.tsx';
import { GroupDetailReport } from './routes/GroupDetailReport.tsx';
import { Report } from './routes/Report.tsx';
import { Settings } from './routes/Settings.tsx';
import { Futures } from './routes/Futures.tsx';
import { Analytics } from './routes/Analytics.tsx';
import { ConnectAccount } from './routes/ConnectAccount.tsx';
import { AccountDetail } from './routes/AccountDetail.tsx';
import { DeskControls } from './routes/DeskControls.tsx';
import { Security } from './routes/Security.tsx';
import { Audit } from './routes/Audit.tsx';
import { Inquiries } from './routes/Inquiries.tsx';
import { NotFound } from './routes/NotFound.tsx';
import { WhatsAppWidget } from './components/WhatsAppWidget.tsx';
import { RouteErrorBoundary } from './components/RouteErrorBoundary.tsx';
import './styles.css';

// A single query client. Previews are never cached — a plan is priced against a
// book that ages, so re-previewing must always hit the server, never a stale
// cache. Reads (groups, assets) may cache briefly.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: false } },
});

interface RouteSeo {
  readonly title: string;
  readonly description: string;
  readonly canonical: string;
  readonly isPublic?: boolean;
}

const SEO_MAP: Record<string, RouteSeo> = {
  '/': {
    title: 'Aza WealthKare - Institutional Non-Custodial Crypto Wealth Management',
    description: 'Aza WealthKare provides institutional-grade non-custodial crypto wealth management. Target 3% to 5% monthly compounding with 100% capital protection guarantee and zero withdrawal access to your funds.',
    canonical: 'https://azawealthkare.com/',
    isPublic: true,
  },
  '/about': {
    title: 'About Us - Aza WealthKare Institutional Crypto Wealth Management',
    description: 'Learn about Aza WealthKare, our non-custodial wealth creation philosophy, institutional trading desk, and commitment to zero counterparty custody risk.',
    canonical: 'https://azawealthkare.com/about',
    isPublic: true,
  },
  '/model': {
    title: 'Investment Model & Strategy - Aza WealthKare',
    description: 'Explore the Aza WealthKare quantitative investment methodology: delta-neutral hedging, basis spread arbitrage, and disciplined 3%–5% monthly compounding.',
    canonical: 'https://azawealthkare.com/model',
    isPublic: true,
  },
  '/guarantee': {
    title: '100% Capital Protection Guarantee - Aza WealthKare',
    description: 'Discover our 100% principal safety guarantee: 12 pre-trade safety gates, sub-millisecond bracket stop-losses, and strictly withdrawal-disabled access.',
    canonical: 'https://azawealthkare.com/guarantee',
    isPublic: true,
  },
  '/contact': {
    title: 'Schedule a Private Wealth Consultation - Aza WealthKare',
    description: 'Connect with an Aza WealthKare senior wealth advisor to structure your non-custodial crypto portfolio and activate automated quantitative management.',
    canonical: 'https://azawealthkare.com/contact',
    isPublic: true,
  },
  '/faq': {
    title: 'Frequently Asked Questions (FAQ) - Aza WealthKare',
    description: 'Comprehensive answers to all questions regarding non-custodial exchange connection, zero withdrawal permissions, 3%–5% returns, and capital protection.',
    canonical: 'https://azawealthkare.com/faq',
    isPublic: true,
  },
  '/login': {
    title: 'Trading Desk Sign In · Aza WealthKare',
    description: 'Authorized access gateway for Aza WealthKare algorithmic trading desks, risk telemetry, and portfolio operations.',
    canonical: 'https://azawealthkare.com/login',
    isPublic: false,
  },
  '/signup': {
    title: 'Create Account · Aza WealthKare',
    description: 'Create an authorized client account on Aza WealthKare.',
    canonical: 'https://azawealthkare.com/signup',
    isPublic: false,
  },
  '/forgot-password': {
    title: 'Forgot Password · Aza WealthKare',
    description: 'Cryptographic password reset for authorized trading desk accounts.',
    canonical: 'https://azawealthkare.com/forgot-password',
    isPublic: false,
  },
  '/reset-password': {
    title: 'Reset Password · Aza WealthKare',
    description: 'Set a new secure password for your trading desk account.',
    canonical: 'https://azawealthkare.com/reset-password',
    isPublic: false,
  },
};

function setMeta(name: string, content: string, isProperty = false) {
  const selector = isProperty ? `meta[property="${name}"]` : `meta[name="${name}"]`;
  let el = document.querySelector(selector);
  if (!el) {
    el = document.createElement('meta');
    if (isProperty) el.setAttribute('property', name);
    else el.setAttribute('name', name);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function setCanonical(href: string) {
  let link = document.querySelector('link[rel="canonical"]');
  if (!link) {
    link = document.createElement('link');
    link.setAttribute('rel', 'canonical');
    document.head.appendChild(link);
  }
  link.setAttribute('href', href);
}

function PageTitleSync() {
  const { branding } = useBranding();
  const location = useLocation();

  useEffect(() => {
    const brand = branding.name || 'Aza WealthKare';
    const path = location.pathname;

    const matched = SEO_MAP[path];
    if (matched) {
      document.title = matched.title;
      setMeta('description', matched.description);
      setMeta('og:title', matched.title, true);
      setMeta('og:description', matched.description, true);
      setMeta('og:url', matched.canonical, true);
      setCanonical(matched.canonical);
      setMeta('twitter:title', matched.title);
      setMeta('twitter:description', matched.description);
      setMeta(
        'robots',
        matched.isPublic
          ? 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
          : 'noindex, nofollow'
      );
      return;
    }

    // Public 404 Not Found handling
    if (!path.startsWith('/app')) {
      const fullTitle = `404 Not Found · ${brand}`;
      document.title = fullTitle;
      setMeta('description', `The page you requested could not be found on ${brand}.`);
      setMeta('og:title', fullTitle, true);
      setMeta('robots', 'noindex, nofollow');
      return;
    }

    // Authenticated management console (/app/*)
    let pageTitle = brand;
    if (path === '/app' || path.startsWith('/app/trades')) {
      pageTitle = 'Trade Execution Desk';
    } else if (path === '/app/inquiries') {
      pageTitle = 'Client Inquiries';
    } else if (path === '/app/positions') {
      pageTitle = 'Futures Positions';
    } else if (path === '/app/analytics') {
      pageTitle = 'Trading Analytics';
    } else if (path === '/app/accounts') {
      pageTitle = 'Exchange Accounts';
    } else if (path.startsWith('/app/accounts/')) {
      pageTitle = 'Account Details';
    } else if (path === '/app/groups' || path.startsWith('/app/groups/')) {
      pageTitle = 'Account Groups';
    } else if (path === '/app/activity') {
      pageTitle = 'Order Blotter';
    } else if (path === '/app/trading') {
      pageTitle = 'Trading Desk Controls';
    } else if (path === '/app/report') {
      pageTitle = 'Performance Reports';
    } else if (path === '/app/security') {
      pageTitle = 'Security & 2FA';
    } else if (path === '/app/audit') {
      pageTitle = 'System Audit Log';
    } else if (path === '/app/settings') {
      pageTitle = 'Branding & Settings';
    }

    const fullTitle = `${pageTitle} · ${brand}`;
    document.title = fullTitle;
    setMeta('description', `${brand} Operations Portal`);
    setMeta('og:title', fullTitle, true);
    setMeta('robots', 'noindex, nofollow');
  }, [location.pathname, branding.name]);

  return null;
}

// AuthProvider is a layout route so it lives INSIDE the router — its children
// (the pages) use both useAuth and router hooks, which only works within the
// RouterProvider context. Everything hangs off it.
function Root() {
  return (
    <BrandingProvider>
      <AuthProvider>
        <PageTitleSync />
        <Outlet />
        <WhatsAppWidget />
      </AuthProvider>
    </BrandingProvider>
  );
}

// Public: the landing and the login page. Gated: everything under /app, wrapped
// in RequireAuth, so no panel screen renders without a live session. The old
// flat routes ('/' = ticket, '/trades/:id') move under /app.
const router = createBrowserRouter([
  {
    element: <Root />,
    errorElement: <RouteErrorBoundary />,
    children: [
      { path: '/', element: <Landing /> },
      { path: '/about', element: <About /> },
      { path: '/model', element: <Model /> },
      { path: '/guarantee', element: <Guarantee /> },
      { path: '/contact', element: <Contact /> },
      { path: '/faq', element: <FaqPage /> },
      { path: '/login', element: <Login /> },
      { path: '/signup', element: <Signup /> },
      { path: '/forgot-password', element: <ForgotPassword /> },
      { path: '/reset-password', element: <ResetPassword /> },
      {
        path: '/app',
        element: <RequireAuth><App /></RequireAuth>,
        children: [
          { index: true, element: <TradeTicket /> },
          { path: 'trades/:groupTradeId/progress', element: <Execution /> },
          { path: 'trades/:groupTradeId', element: <Confirmation /> },
          { path: 'groups', element: <Groups /> },
          { path: 'groups/:groupId', element: <GroupDetail /> },
          { path: 'accounts', element: <Accounts /> },
          { path: 'positions', element: <Futures /> },
          { path: 'analytics', element: <Analytics /> },
          { path: 'activity', element: <Blotter /> },
          { path: 'activity/groups/:groupTradeId', element: <GroupDetailReport /> },
          { path: 'report', element: <Report /> },
          { path: 'settings', element: <Settings /> },
          { path: 'accounts/connect', element: <ConnectAccount /> },
          { path: 'accounts/:accountId', element: <AccountDetail /> },
          { path: 'trading', element: <DeskControls /> },
          { path: 'security', element: <Security /> },
          { path: 'audit', element: <Audit /> },
          { path: 'inquiries', element: <Inquiries /> },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

const rootEl = document.getElementById('root');
if (rootEl === null) throw new Error('#root is missing from index.html');

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
