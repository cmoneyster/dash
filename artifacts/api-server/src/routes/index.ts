import { Router, type IRouter } from "express";
import { requireAdminAuth } from "../lib/adminAuth";
import healthRouter from "./health";
import menuRouter from "./menu";
import adminAuthRouter from "./admin-auth";
import adminMenuRouter from "./admin-menu";
import adminMenuCsvRouter from "./admin-menu-csv";
import adminImagesRouter from "./admin-images";
import eventsRouter from "./events";
import cartRouter from "./cart";
import planRouter from "./plan";
import ordersRouter from "./orders";
import chatRouter from "./chat";
import adminStatsRouter from "./admin-stats";
import storageRouter from "./storage";
import eventOrderingRouter from "./event-ordering";
import eventTakerRouter from "./event-taker";
import adminEventRouter from "./admin-event";
import adminEventSessionsRouter from "./admin-event-sessions";
import adminCateringRouter from "./admin-catering";
import adminPlansRouter from "./admin-plans";
import quotePublicRouter from "./quote-public";
import webhooksSquareRouter from "./webhooks-square";
import verifyRouter from "./verify";
import categoriesRouter from "./categories";
import adminCategoriesRouter from "./admin-categories";
import placesRouter from "./places";
import socialShareRouter from "./social-share";

const router: IRouter = Router();

router.use(healthRouter);
router.use(menuRouter);
router.use(cartRouter);
router.use(planRouter);
router.use(ordersRouter);
router.use(chatRouter);
router.use(eventsRouter);
router.use(categoriesRouter);
router.use(storageRouter);
router.use(eventOrderingRouter);
router.use(eventTakerRouter);
router.use(verifyRouter);
router.use(placesRouter);
router.use(socialShareRouter);
router.use(quotePublicRouter);
// Public webhook — must be mounted BEFORE the admin auth middleware below.
router.use(webhooksSquareRouter);

router.use(adminAuthRouter);

router.use("/admin/menu", requireAdminAuth);
router.use("/admin/stats", requireAdminAuth);
router.use("/admin/orders", requireAdminAuth);
router.use("/admin/blackout-dates", requireAdminAuth);
router.use("/admin/event-settings", requireAdminAuth);
router.use("/admin/sales-reports", requireAdminAuth);
router.use("/admin/sales-reports.csv", requireAdminAuth);
router.use("/admin/event-sessions", requireAdminAuth);
router.use("/admin/catering", requireAdminAuth);
router.use("/admin/plans", requireAdminAuth);
router.use("/admin/categories", requireAdminAuth);

router.use(adminMenuRouter);
router.use(adminMenuCsvRouter);
router.use(adminCategoriesRouter);
router.use(adminStatsRouter);
router.use(adminImagesRouter);
router.use(adminEventRouter);
router.use(adminEventSessionsRouter);
router.use(adminCateringRouter);
router.use(adminPlansRouter);

export default router;
