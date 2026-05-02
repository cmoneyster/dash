import { Link } from "wouter";
import { Layout } from "@/components/Layout";
import { HashtagWall } from "@/components/HashtagWall";
import { FirstVisitInterstitial } from "@/components/FirstVisitInterstitial";
import { ArrowRight, Star, Clock, CalendarCheck } from "lucide-react";

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
              dash by Hollywood East Cafe brings bold, fresh, Asian-inspired flavors to your event — from intimate gatherings to large celebrations.
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
                className="px-8 py-4 bg-white text-foreground font-bold rounded-xl border border-border shadow-sm hover:border-primary/50 hover:bg-secondary/50 transition-all text-center"
              >
                Start Planning
              </Link>
            </div>
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
                Use our intelligent planning tools and AI concierge to effortlessly design the perfect menu for your guest count.
              </p>
            </div>
          </div>
        </div>
      </section>

      <HashtagWall surface="home" />
    </Layout>
  );
}
