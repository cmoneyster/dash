import { Router, type IRouter } from "express";
import { requireAdminAuth } from "../lib/adminAuth";
import healthRouter from "./health";
import menuRouter from "./menu";
import adminAuthRouter from "./admin-auth";
import adminMenuRouter from "./admin-menu";
import adminImagesRouter from "./admin-images";
import eventsRouter from "./events";
import cartRouter from "./cart";
import planRouter from "./plan";
import ordersRouter from "./orders";
import chatRouter from "./chat";
import adminStatsRouter from "./admin-stats";
import storageRouter from "./storage";
import eventOrderingRouter from "./event-ordering";
import adminEventRouter from "./admin-event";

const router: IRouter = Router();

router.use(healthRouter);
router.use(menuRouter);
router.use(cartRouter);
router.use(planRouter);
router.use(ordersRouter);
router.use(chatRouter);
router.use(eventsRouter);
router.use(storageRouter);
router.use(eventOrderingRouter);

router.use(adminAuthRouter);

router.use("/admin/menu", requireAdminAuth);
router.use("/admin/stats", requireAdminAuth);
router.use("/admin/orders", requireAdminAuth);
router.use("/admin/blackout-dates", requireAdminAuth);
router.use("/admin/event-settings", requireAdminAuth);

router.use(adminMenuRouter);
router.use(adminStatsRouter);
router.use(adminImagesRouter);
router.use(adminEventRouter);

export default router;
