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
import PublicQuote from "@/pages/PublicQuote";
import EventTakerOrder from "@/pages/EventTakerOrder";
import KitchenDisplay from "@/pages/KitchenDisplay";
import OrderStatus from "@/pages/OrderStatus";
import Gallery from "@/pages/Gallery";

import SharedPlan from "@/pages/SharedPlan";
import AdminLogin from "@/pages/admin/Login";
import AdminDashboard from "@/pages/admin/Dashboard";
import MenuManager from "@/pages/admin/MenuManager";
import CategoryManager from "@/pages/admin/CategoryManager";
import OrderManager from "@/pages/admin/OrderManager";
import CalendarManager from "@/pages/admin/CalendarManager";
import ImageLibrary from "@/pages/admin/ImageLibrary";
import EventSettings from "@/pages/admin/EventSettings";
import EventHistory from "@/pages/admin/EventHistory";
import SalesReports from "@/pages/admin/SalesReports";
import CateringOrders from "@/pages/admin/CateringOrders";
import CateringPlans from "@/pages/admin/CateringPlans";
import UpcomingCaterings from "@/pages/admin/UpcomingCaterings";
import HashtagWallModeration from "@/pages/admin/HashtagWallModeration";
import SmsSettings from "@/pages/admin/SmsSettings";
import UnmatchedMessages from "@/pages/admin/UnmatchedMessages";
import IdleActivity from "@/pages/admin/IdleActivity";

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
      <Route path="/plan/share/:token" component={SharedPlan} />
      <Route path="/confirmation" component={Confirmation} />
      <Route path="/event" component={EventOrder} />
      <Route path="/quote/:token" component={PublicQuote} />
      <Route path="/event-taker" component={EventTakerOrder} />
      <Route path="/event/order/:id" component={OrderStatus} />
      <Route path="/kitchen" component={KitchenDisplay} />
      <Route path="/gallery" component={Gallery} />

      <Route path="/admin/login" component={AdminLogin} />

      <Route path="/admin">
        {() => <AdminGuard><AdminDashboard /></AdminGuard>}
      </Route>
      <Route path="/admin/menu">
        {() => <AdminGuard><MenuManager /></AdminGuard>}
      </Route>
      <Route path="/admin/categories">
        {() => <AdminGuard><CategoryManager /></AdminGuard>}
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
      <Route path="/admin/event-history">
        {() => <AdminGuard><EventHistory /></AdminGuard>}
      </Route>
      <Route path="/admin/sales-reports">
        {() => <AdminGuard><SalesReports /></AdminGuard>}
      </Route>
      <Route path="/admin/catering">
        {() => <AdminGuard><CateringOrders /></AdminGuard>}
      </Route>
      <Route path="/admin/catering/upcoming">
        {() => <AdminGuard><UpcomingCaterings /></AdminGuard>}
      </Route>
      <Route path="/admin/catering/plans">
        {() => <AdminGuard><CateringPlans /></AdminGuard>}
      </Route>
      <Route path="/admin/social/hashtag-wall">
        {() => <AdminGuard><HashtagWallModeration /></AdminGuard>}
      </Route>
      <Route path="/admin/sms">
        {() => <AdminGuard><SmsSettings /></AdminGuard>}
      </Route>
      <Route path="/admin/messages/unmatched">
        {() => <AdminGuard><UnmatchedMessages /></AdminGuard>}
      </Route>
      <Route path="/admin/idle-activity">
        {() => <AdminGuard><IdleActivity /></AdminGuard>}
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
