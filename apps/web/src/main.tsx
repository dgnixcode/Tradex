import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createBrowserRouter } from 'react-router-dom';
import { AuthProvider, RequireAuth } from './auth.tsx';
import { App } from './App.tsx';
import { Landing } from './routes/Landing.tsx';
import { Login } from './routes/Login.tsx';
import { Signup } from './routes/Signup.tsx';
import { TradeTicket } from './routes/TradeTicket.tsx';
import { Confirmation } from './routes/Confirmation.tsx';
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
    <AuthProvider>
      <Outlet />
    </AuthProvider>
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
      { path: '/login', element: <Login /> },
      { path: '/signup', element: <Signup /> },
      {
        path: '/app',
        element: <RequireAuth><App /></RequireAuth>,
        children: [
          { index: true, element: <TradeTicket /> },
          { path: 'trades/:groupTradeId', element: <Confirmation /> },
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
