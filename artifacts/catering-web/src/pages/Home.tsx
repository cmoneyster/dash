import { Link } from "wouter";
import { Layout } from "@/components/Layout";
import { HashtagWall } from "@/components/HashtagWall";
import { FirstVisitInterstitial } from "@/components/FirstVisitInterstitial";
import { ArrowRight, Star, Clock, CalendarCheck, UtensilsCrossed, ShoppingBag, Users, Send } from "lucide-react";

const HOW_IT_WORKS_STEPS = [
  {
    number: "1",
    icon: UtensilsCrossed,
    title: "Browse the Menu",
    body: "Explore our full menu of Asian-inspired dishes. Filter by category or let Dashy, our AI assistant, help you narrow it down.",
  },
  {
    number: "2",
    icon: ShoppingBag,
    title: "Add Items to Your Plan",
    body: "Build your custom menu — any order size is welcome. A single pan, a few items, or a full spread. Drop-off or meet-up, we make it work.",
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
  return (
    <Layout>
      <FirstVisitInterstitial />
      {/* Hero Section */}
      <section className="relative pt-32 pb-40 overflow-hidden">
        <div className="absolute inset-0 z-0">
          {/* landing page hero scenic catering table spread */}
          <img 
            src={`${import.meta.env.BASE_URL}images/hero.png`}
            alt="Beautiful catering spread"
            className="w-full h-full object-cover object-center"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-background/95 via-background/80 to-transparent" />
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="max-w-2xl">
            <span className="inline-block py-1 px-3 rounded-full bg-primary/10 text-primary font-bold text-xs uppercase tracking-widest mb-6">
              Modern Asian-Inspired Catering
            </span>
            <h1 className="font-display text-5xl md:text-7xl font-bold text-foreground leading-[1.1] mb-6 text-balance">
              Bold flavors. Unforgettable events.
            </h1>
            <p className="text-lg md:text-xl text-foreground/70 mb-10 leading-relaxed max-w-xl">
              dash by Hollywood East Cafe brings bold, fresh, Asian-inspired flavors to your event — from a single pan drop-off to a full-scale celebration.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link 
                href="/menu" 
                className="px-8 py-4 bg-primary text-primary-foreground font-bold rounded-xl shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 hover:-translate-y-0.5 transition-all text-center flex items-center justify-center gap-2"
              >
                Explore Menu <ArrowRight className="w-5 h-5" />
              </Link>
              <Link 
                href="/plan" 
                className="px-8 py-4 bg-card text-foreground font-bold rounded-xl border border-border shadow-sm hover:border-primary/50 hover:bg-secondary/50 transition-all text-center"
              >
                Start Planning
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="py-20 bg-secondary/40 border-y border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <span className="inline-block py-1 px-3 rounded-full bg-primary/10 text-primary font-bold text-xs uppercase tracking-widest mb-4">
              Simple &amp; flexible
            </span>
            <h2 className="font-display font-bold text-3xl sm:text-4xl mb-3">
              How it works
            </h2>
            <p className="text-muted-foreground max-w-xl mx-auto">
              From browsing to your door — here's how to place a catering order in four easy steps.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8">
            {HOW_IT_WORKS_STEPS.map((step) => {
              const Icon = step.icon;
              return (
                <div key={step.number} className="relative flex flex-col bg-card rounded-2xl border border-border p-6 shadow-sm">
                  <div className="flex items-center gap-3 mb-4">
                    <span className="w-8 h-8 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center shrink-0">
                      {step.number}
                    </span>
                    <div className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center text-primary shrink-0">
                      <Icon className="w-5 h-5" />
                    </div>
                  </div>
                  <h3 className="font-display font-bold text-lg mb-2">{step.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{step.body}</p>
                </div>
              );
            })}
          </div>

          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4 text-center sm:text-left">
            <div className="px-5 py-3 rounded-xl bg-primary/10 border border-primary/20 text-sm font-semibold text-primary">
              No minimum order — single pans, small orders, and drop-off or meet-up all welcome
            </div>
            <Link
              href="/menu"
              className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground font-bold rounded-xl shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all text-sm"
            >
              Browse the Menu <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-24 bg-background">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-12">
            <div className="flex flex-col items-start">
              <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center text-primary mb-6">
                <Star className="w-7 h-7" />
              </div>
              <h3 className="font-display font-bold text-2xl mb-3">Bold Flavors</h3>
              <p className="text-muted-foreground leading-relaxed">
                Authentic, Asian-inspired recipes crafted to bring exciting, bold tastes to every bite of your event's menu.
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
                <CalendarCheck className="w-7 h-7" />
              </div>
              <h3 className="font-display font-bold text-2xl mb-3">Seamless Planning</h3>
              <p className="text-muted-foreground leading-relaxed">
                Use our intelligent planning tools and dashy, our AI assistant, to effortlessly design the perfect menu for your guest count.
              </p>
            </div>
          </div>
        </div>
      </section>

      <HashtagWall surface="home" />
    </Layout>
  );
}
