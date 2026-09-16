import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createBrowserRouter } from 'react-router-dom';
import { AuthProvider, RequireAuth } from './auth.tsx';
import { BrandingProvider } from './branding.tsx';
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
import { ConnectAccount } from './routes/ConnectAccount.tsx';
import { AccountDetail } from './routes/AccountDetail.tsx';
import { DeskControls } from './routes/DeskControls.tsx';
import { Security } from './routes/Security.tsx';
import { Audit } from './routes/Audit.tsx';
import './styles.css';

// A single query client. Previews are never cached — a plan is priced against a
// book that ages, so re-previewing must always hit the server, never a stale
// cache. Reads (groups, assets) may cache briefly.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: false } },
});

// AuthProvider is a layout route so it lives INSIDE the router — its children
// (the pages) use both useAuth and router hooks, which only works within the
// RouterProvider context. Everything hangs off it.
function Root() {
  return (
    <BrandingProvider>
      <AuthProvider>
        <Outlet />
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
          { path: 'activity', element: <Blotter /> },
          { path: 'activity/groups/:groupTradeId', element: <GroupDetailReport /> },
          { path: 'report', element: <Report /> },
          { path: 'settings', element: <Settings /> },
          { path: 'accounts/connect', element: <ConnectAccount /> },
          { path: 'accounts/:accountId', element: <AccountDetail /> },
          { path: 'trading', element: <DeskControls /> },
          { path: 'security', element: <Security /> },
          { path: 'audit', element: <Audit /> },
        ],
      },
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
