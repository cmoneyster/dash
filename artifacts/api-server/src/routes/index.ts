import { Router, type IRouter } from "express";
import healthRouter from "./health";
import menuRouter from "./menu";
import adminMenuRouter from "./admin-menu";
import eventsRouter from "./events";
import cartRouter from "./cart";
import planRouter from "./plan";
import ordersRouter from "./orders";
import chatRouter from "./chat";
import adminStatsRouter from "./admin-stats";

const router: IRouter = Router();

router.use(healthRouter);
router.use(menuRouter);
router.use(adminMenuRouter);
router.use(eventsRouter);
router.use(cartRouter);
router.use(planRouter);
router.use(ordersRouter);
router.use(chatRouter);
router.use(adminStatsRouter);

export default router;
