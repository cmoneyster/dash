import { useCallback, useEffect, useRef, type RefObject } from "react";
import { driver, type Driver, type DriveStep } from "driver.js";
import "driver.js/dist/driver.css";

const TOUR_SEEN_KEY = "dash_demo_tour_seen_v1";

type Refs = {
  categoriesRef: RefObject<HTMLDivElement | null>;
  itemCardRef: RefObject<HTMLDivElement | null>;
  cartRef: RefObject<HTMLDivElement | null>;
  formRef: RefObject<HTMLFormElement | null>;
  submitBtnRef: RefObject<HTMLButtonElement | null>;
  confirmRef: RefObject<HTMLDivElement | null>;
};

// 6-step spotlight tour for the public demo guest ordering page.
// Driver.js draws a circle/rectangle highlight around each anchor and
// dims the rest of the page. "Skip tour" and the close button both
// exit immediately and stamp the localStorage flag so the auto-run
// doesn't fire again on the same device. The "Show tour" link in the
// banner calls replay() which ignores the flag.
export function useDemoTour(refs: Refs) {
  const driverRef = useRef<Driver | null>(null);

  useEffect(() => {
    return () => {
      driverRef.current?.destroy();
      driverRef.current = null;
    };
  }, []);

  const buildShoppingSteps = useCallback((): DriveStep[] => {
    const steps: DriveStep[] = [];
    if (refs.categoriesRef.current) {
      steps.push({
        element: refs.categoriesRef.current,
        popover: {
          title: "Browse by category",
          description: "Guests scroll through your real menu, grouped exactly the way it appears at the event.",
        },
      });
    }
    if (refs.itemCardRef.current) {
      steps.push({
        element: refs.itemCardRef.current,
        popover: {
          title: "Add an item",
          description: "Tap the + button to add an item to the order. Try it now to follow along.",
        },
      });
    }
    if (refs.cartRef.current) {
      steps.push({
        element: refs.cartRef.current,
        popover: {
          title: "Review the order",
          description: "Selected items appear here in real time, just like guests will see at your event.",
        },
      });
    }
    if (refs.formRef.current) {
      steps.push({
        element: refs.formRef.current,
        popover: {
          title: "Name and phone",
          description:
            "Guests enter a name and phone so the kitchen can text them when their food is ready. For this demo we'll text the number you enter.",
        },
      });
    }
    if (refs.submitBtnRef.current) {
      steps.push({
        element: refs.submitBtnRef.current,
        popover: {
          title: "Place the demo order",
          description: "Submitting sends one real text with a sample tracking link — no charges, no kitchen ticket.",
        },
      });
    }
    return steps;
  }, [refs]);

  const buildConfirmationSteps = useCallback((): DriveStep[] => {
    if (!refs.confirmRef.current) return [];
    return [
      {
        element: refs.confirmRef.current,
        popover: {
          title: "Sample text on the way",
          description:
            "This is the post-order screen guests see. The sample tracking link in your text mirrors the live experience.",
        },
      },
    ];
  }, [refs]);

  const run = useCallback(
    ({ phase, auto }: { phase: "shopping" | "confirmation"; auto: boolean }) => {
      // Only the shopping tour is gated by the "seen" flag. The
      // confirmation step fires once per submission and should always
      // play — otherwise first-time users miss it because the shopping
      // tour already stamped the flag when it ended.
      if (auto && phase === "shopping") {
        try {
          if (localStorage.getItem(TOUR_SEEN_KEY)) return;
        } catch {
          // localStorage unavailable — proceed anyway.
        }
      }
      const steps = phase === "shopping" ? buildShoppingSteps() : buildConfirmationSteps();
      if (steps.length === 0) return;

      driverRef.current?.destroy();
      const d = driver({
        showProgress: true,
        allowClose: true,
        showButtons: ["next", "previous", "close"],
        nextBtnText: "Next",
        prevBtnText: "Back",
        doneBtnText: "Got it",
        // Driver.js renders the "close" control as an X icon by default.
        // Inject an explicit "Skip tour" text button into the footer so
        // the dismiss action is unmistakable for first-time users.
        onPopoverRender: (popover) => {
          const footer = popover.footerButtons;
          if (!footer) return;
          if (footer.querySelector('[data-demo-skip="1"]')) return;
          const skip = document.createElement("button");
          skip.type = "button";
          skip.textContent = "Skip tour";
          skip.dataset.demoSkip = "1";
          skip.className = "driver-popover-close-btn";
          skip.style.marginRight = "auto";
          skip.addEventListener("click", () => driverRef.current?.destroy());
          footer.insertBefore(skip, footer.firstChild);
        },
        progressText: "{{current}} of {{total}}",
        onDestroyed: () => {
          if (phase === "shopping") {
            try {
              localStorage.setItem(TOUR_SEEN_KEY, String(Date.now()));
            } catch {
              // ignore
            }
          }
        },
        steps,
      });
      driverRef.current = d;
      d.drive();
    },
    [buildShoppingSteps, buildConfirmationSteps],
  );

  const replay = useCallback(() => {
    try {
      localStorage.removeItem(TOUR_SEEN_KEY);
    } catch {
      // ignore
    }
    run({ phase: "shopping", auto: false });
  }, [run]);

  return { run, replay };
}
