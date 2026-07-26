import { useState, useEffect } from "react";
import { usePageMeta } from "@/lib/usePageMeta";
import { Link } from "wouter";
import { Layout } from "@/components/Layout";
import { HashtagWall } from "@/components/HashtagWall";
import { FirstVisitInterstitial } from "@/components/FirstVisitInterstitial";
import { ArrowRight, Star, Clock, Flame, UtensilsCrossed, ShoppingBag, Users, Send } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const HOW_IT_WORKS_STEPS = [
  {
    number: "1",
    icon: UtensilsCrossed,
    title: "Browse the Menu",
    body: "Explore our full menu of bold, eclectic dishes — and a secret items section with surprises beyond the usual. Filter by category to find exactly what you're looking for.",
  },
  {
    number: "2",
    icon: ShoppingBag,
    title: "Build & Share Your Plan",
    body: "Add items to your plan — any size is welcome, from a single pan to a full spread. Planning with a partner or family? Share your plan via a simple link and co-plan together in real time. No sign-up needed.",
  },
  {
    number: "3",
    icon: Users,
    title: "Check Serving Amounts",
    body: "Enter your guest count and the Event Plan tells you whether you have enough food — with suggestions if you need a little more.",
  },
  {
    number: "4",
    icon: Send,
    title: "Submit Your Inquiry",
    body: "Share your event details and send us your plan. We'll confirm availability, answer any questions, and finalize the order with you.",
  },
];

export default function Home() {
  usePageMeta({
    title: "dash Catering by Hollywood East Cafe",
    description: "dash by Hollywood East Cafe — Asian-inspired food built on 30+ years of recipes. Fresh drop-off or on-site with the On The Dash mobile kitchen.",
  });
  const [heroImageUrl, setHeroImageUrl] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${BASE}/api/site-config`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.heroImageUrl) setHeroImageUrl(data.heroImageUrl); })
      .catch(() => {});
  }, []);

  const heroSrc = heroImageUrl ?? `${import.meta.env.BASE_URL}images/hero.png`;

  return (
    <Layout>
      <FirstVisitInterstitial />

      {/* Hero + How It Works — unified overlapping section */}
      <section className="relative pt-20 pb-0 overflow-visible">
        {/* Background photo */}
        <div className="absolute inset-x-0 top-0 h-[300px] sm:h-[340px] z-0">
          <img
            src={heroSrc}
            alt="Beautiful catering spread"
            className="w-full h-full object-cover object-center"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-background/95 via-background/80 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-background to-transparent" />
        </div>

        {/* Hero text */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="max-w-2xl pb-14 sm:pb-16">
            <span className="inline-block py-1 px-3 rounded-full bg-primary/10 text-primary font-bold text-xs uppercase tracking-widest mb-4">
              The On The Dash Experience
            </span>
            <h1 className="font-display text-3xl md:text-4xl font-bold text-foreground leading-[1.1] mb-4 text-balance">
              We bring the kitchen to you.
            </h1>
            <p className="text-sm md:text-base text-foreground/70 mb-6 leading-relaxed max-w-xl">
              Our food trailer comes on-site and cooks bold, fresh food live at your event — hot off the grill, crispy from the fryer, or freshly steamed, right in front of your guests. Prefer drop-off or a meet-up? We do that too. Our menu is rooted in bold Asian-inspired flavors, with an eclectic range that goes beyond any single style.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                href="/menu"
                className="px-7 py-3.5 bg-primary text-primary-foreground font-bold rounded-xl shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 hover:-translate-y-0.5 transition-all text-center flex items-center justify-center gap-2"
              >
                Explore Menu <ArrowRight className="w-5 h-5" />
              </Link>
              <Link
                href="/plan"
                className="px-7 py-3.5 bg-card text-foreground font-bold rounded-xl border border-border shadow-sm hover:border-primary/50 hover:bg-secondary/50 transition-all text-center"
              >
                Start Planning
              </Link>
            </div>
          </div>
        </div>

        {/* How It Works cards — overlap only on desktop; stack naturally on mobile */}
        <div className="relative z-10 mt-0 lg:-mt-16 pb-16 bg-gradient-to-b from-transparent to-background">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="mb-6 text-center">
              <span className="inline-block py-1 px-3 rounded-full bg-primary/10 text-primary font-bold text-xs uppercase tracking-widest mb-3">
                Simple &amp; flexible
              </span>
              <h2 className="font-display font-bold text-2xl sm:text-3xl">
                How it works
              </h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-6">
              {HOW_IT_WORKS_STEPS.map((step) => {
                const Icon = step.icon;
                return (
                  <div key={step.number} className="relative flex flex-col bg-card rounded-2xl border border-border p-5 shadow-md">
                    <div className="flex items-center gap-3 mb-3">
                      <span className="w-7 h-7 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center shrink-0">
                        {step.number}
                      </span>
                      <div className="w-8 h-8 rounded-xl bg-secondary flex items-center justify-center text-primary shrink-0">
                        <Icon className="w-4 h-4" />
                      </div>
                    </div>
                    <h3 className="font-display font-bold text-base mb-1.5">{step.title}</h3>
                    <p className="text-xs text-muted-foreground leading-relaxed">{step.body}</p>
                  </div>
                );
              })}
            </div>

            <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-4 text-center sm:text-left">
              <div className="px-5 py-3 rounded-xl bg-primary/10 border border-primary/20 text-sm font-semibold text-primary">
                Food trailer on-site cooking · drop-off · meet-up · no minimum order
              </div>
              <Link
                href="/menu"
                className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground font-bold rounded-xl shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all text-sm"
              >
                Browse the Menu <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-20 bg-background">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-12">
            <div className="flex flex-col items-start">
              <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center text-primary mb-6">
                <Star className="w-7 h-7" />
              </div>
              <h3 className="font-display font-bold text-2xl mb-3">Bold, Eclectic Flavors</h3>
              <p className="text-muted-foreground leading-relaxed">
                Our menu is rooted in bold, Asian-inspired recipes with an eclectic range that goes beyond any single style — expect exciting, unexpected flavors at every event.
              </p>
            </div>
            <div className="flex flex-col items-start">
              <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center text-primary mb-6">
                <Clock className="w-7 h-7" />
              </div>
              <h3 className="font-display font-bold text-2xl mb-3">Fresh Ingredients</h3>
              <p className="text-muted-foreground leading-relaxed">
                We source only the highest quality, freshest ingredients to ensure visually stunning and remarkably delicious dishes.
              </p>
            </div>
            <div className="flex flex-col items-start">
              <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center text-primary mb-6">
                <Flame className="w-7 h-7" />
              </div>
              <h3 className="font-display font-bold text-2xl mb-3">On-Site Experience</h3>
              <p className="text-muted-foreground leading-relaxed">
                Our food trailer arrives at your venue and cooks everything fresh, right in front of your guests — hot off the grill, crispy from the fryer, or freshly steamed, made to order at your event.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* About */}
      <section className="py-20 bg-secondary/20 border-t border-border">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <span className="inline-block py-1 px-3 rounded-full bg-primary/10 text-primary font-bold text-xs uppercase tracking-widest mb-4">
            About Us
          </span>
          <h2 className="font-display font-bold text-2xl sm:text-3xl mb-6">
            dash by Hollywood East Cafe
          </h2>
          <p className="text-muted-foreground leading-relaxed mb-5 text-base">
            dash by Hollywood East Cafe brings chef-crafted, Asian-inspired food and more — straight to your event. Built on recipes over 30 years in the making, choose between a fresh drop-off delivery or the full On The Dash mobile kitchen experience, where our team prepares everything on-site so it's hot, fresh, and ready the moment your guests are. Whether you're hosting an intimate gathering, a corporate lunch, or a large celebration, we make sure the food is the highlight.
          </p>
          <p className="text-muted-foreground leading-relaxed text-base">
            Plan your event your way. Our interactive event planning tool lets you browse the full menu, build your event plan, and request a quote — all in one place. Share your event plan with a link, so collaborating with family, colleagues, or co-hosts is effortless.
          </p>
        </div>
      </section>

      <HashtagWall surface="home" />
    </Layout>
  );
}
