import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AdminGuard } from "@/components/AdminGuard";

import Home from "@/pages/Home";
import Menu from "@/pages/Menu";
import Cart from "@/pages/Cart";
import Plan from "@/pages/Plan";
import Confirmation from "@/pages/Confirmation";
import NotFound from "@/pages/not-found";
import EventOrder from "@/pages/EventOrder";
import KitchenDisplay from "@/pages/KitchenDisplay";

import AdminLogin from "@/pages/admin/Login";
import AdminDashboard from "@/pages/admin/Dashboard";
import MenuManager from "@/pages/admin/MenuManager";
import OrderManager from "@/pages/admin/OrderManager";
import CalendarManager from "@/pages/admin/CalendarManager";
import ImageLibrary from "@/pages/admin/ImageLibrary";
import EventSettings from "@/pages/admin/EventSettings";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/menu" component={Menu} />
      <Route path="/cart" component={Cart} />
      <Route path="/plan" component={Plan} />
      <Route path="/confirmation" component={Confirmation} />
      <Route path="/event" component={EventOrder} />
      <Route path="/kitchen" component={KitchenDisplay} />

      <Route path="/admin/login" component={AdminLogin} />

      <Route path="/admin">
        {() => <AdminGuard><AdminDashboard /></AdminGuard>}
      </Route>
      <Route path="/admin/menu">
        {() => <AdminGuard><MenuManager /></AdminGuard>}
      </Route>
      <Route path="/admin/orders">
        {() => <AdminGuard><OrderManager /></AdminGuard>}
      </Route>
      <Route path="/admin/calendar">
        {() => <AdminGuard><CalendarManager /></AdminGuard>}
      </Route>
      <Route path="/admin/images">
        {() => <AdminGuard><ImageLibrary /></AdminGuard>}
      </Route>
      <Route path="/admin/event-settings">
        {() => <AdminGuard><EventSettings /></AdminGuard>}
      </Route>

      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
