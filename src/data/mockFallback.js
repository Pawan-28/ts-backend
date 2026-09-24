/** Static mock payloads — used when DB is empty or unavailable. Do not remove. */

const FILTER_DATA = {
  today: {
    kpis: [
      { label: "Total Revenue", value: "₹12.0L", icon: "DollarSign" },
      { label: "Cash Collected", value: "₹1.2L", icon: "DollarSign" },
      { label: "Total Leads", value: "15", icon: "Users" },
      { label: "Total Calls", value: "48", icon: "Phone" },
      { label: "Qualified Leads", value: "7", icon: "FileText" },
      { label: "Pipeline Value", value: "₹91.3L", icon: "DollarSign" },
      { label: "Closings", value: "3", icon: "Trophy" },
    ],
    leaderboard: [
      { name: "Aryan S.", leads: 18, resp: "1h 20m", qualR: "72%", convR: "19%", conv: 3, rev: "₹0.3L" },
      { name: "Priya M.", leads: 14, resp: "1h 45m", qualR: "66%", convR: "14%", conv: 2, rev: "₹0.2L" },
      { name: "Rahul K.", leads: 11, resp: "2h 10m", qualR: "59%", convR: "11%", conv: 1, rev: "₹0.1L" },
    ],
    metrics: { pickup: 68, qualification: 38, conversion: 8 },
    insights: [
      { type: "check", text: "₹0.2L stuck in negotiation > 2 days" },
      { type: "warn", text: "6 leads inactive since 4 hours" },
    ],
    activity: [
      { type: "check", text: "New lead from paid campaign — Web Dev" },
      { type: "warn", text: "Aryan's follow-up overdue by 2h" },
    ],
  },
  week: {
    kpis: [
      { label: "Total Revenue", value: "₹7.9L", icon: "DollarSign" },
      { label: "Cash Collected", value: "₹5.1L", icon: "DollarSign" },
      { label: "Total Leads", value: "286", icon: "Users" },
      { label: "Total Calls", value: "620", icon: "Phone" },
      { label: "Qualified Leads", value: "42", icon: "FileText" },
      { label: "Pipeline Value", value: "₹12.4L", icon: "DollarSign" },
      { label: "Closings", value: "18", icon: "Trophy" },
    ],
    leaderboard: [
      { name: "Priya", leads: 42, resp: "2h", qualR: "68%", convR: "22%", conv: 9, rev: "₹2.4L" },
      { name: "Rahul", leads: 38, resp: "2h 15m", qualR: "61%", convR: "18%", conv: 7, rev: "₹1.9L" },
      { name: "Aman", leads: 31, resp: "2h 40m", qualR: "55%", convR: "15%", conv: 5, rev: "₹1.5L" },
    ],
    metrics: { pickup: 72, qualification: 42, conversion: 18 },
    insights: [
      { type: "check", text: "12 leads inactive for 7+ days" },
      { type: "warn", text: "3 negotiations stuck" },
    ],
    activity: [
      { type: "check", text: "Lead moved to negotiation" },
      { type: "check", text: "Follow-up completed" },
    ],
  },
  month: {
    kpis: [
      { label: "Total Revenue", value: "₹31.4L", icon: "DollarSign" },
      { label: "Cash Collected", value: "₹22.8L", icon: "DollarSign" },
      { label: "Total Leads", value: "1,303", icon: "Users" },
      { label: "Total Calls", value: "2,612", icon: "Phone" },
      { label: "Qualified Leads", value: "148", icon: "FileText" },
      { label: "Pipeline Value", value: "₹48.6L", icon: "DollarSign" },
      { label: "Closings", value: "78", icon: "Trophy" },
    ],
    leaderboard: [
      { name: "Alex Chen", leads: 124, resp: "1h 50m", qualR: "74%", convR: "28%", conv: 24, rev: "₹4.1L" },
      { name: "Maya Singh", leads: 98, resp: "2h 05m", qualR: "69%", convR: "24%", conv: 19, rev: "₹3.2L" },
      { name: "Jordan Lee", leads: 86, resp: "2h 20m", qualR: "63%", convR: "20%", conv: 15, rev: "₹2.4L" },
    ],
    metrics: { pickup: 78, qualification: 48, conversion: 24 },
    insights: [
      { type: "check", text: "Conversion improved by 14%" },
      { type: "warn", text: "8 missing follow-ups" },
    ],
    activity: [
      { type: "check", text: "Invoice generated" },
      { type: "check", text: "Target achieved for May" },
    ],
  },
};

const revenueSeries = [
  { month: "Jan", revenue: 82, forecast: 78 },
  { month: "Feb", revenue: 95, forecast: 88 },
  { month: "Mar", revenue: 110, forecast: 102 },
  { month: "Apr", revenue: 128, forecast: 118 },
  { month: "May", revenue: 145, forecast: 132 },
  { month: "Jun", revenue: 162, forecast: 148 },
];

const aiInsights = [
  { type: "prediction", title: "High-value deal likely to close", body: "Top lead shows strong engagement signals.", tone: "success" },
  { type: "risk", title: "Inactive leads detected", body: "Several leads have no activity in 7+ days.", tone: "warning" },
  { type: "rec", title: "Rebalance workload", body: "Consider redistributing leads across team.", tone: "info" },
];

const SERVICES = [
  {
    id: "ai-automation",
    name: "AI Automation Suite",
    category: "ai",
    categoryLabel: "AI Solutions",
    status: "ACTIVE",
    badge: "POPULAR",
    description: "End-to-end workflow automation powered by custom LLM agents.",
    tags: ["AI SOLUTIONS", "6-8 WEEKS"],
    revenue: 450000,
    clients: 128,
    leads: 12482,
    converted: 842,
    convRate: 6.8,
    price: "₹15,000/mo",
    priceNum: 15000,
    icon: "bot",
    features: [],
  },
  {
    id: "crm-setup",
    name: "CRM Setup & Onboarding",
    category: "crm",
    categoryLabel: "CRM & Ops",
    status: "ACTIVE",
    badge: null,
    description: "Full CRM implementation and team onboarding.",
    tags: ["CRM & OPS", "4-6 WEEKS"],
    revenue: 300000,
    clients: 96,
    leads: 8420,
    converted: 612,
    convRate: 7.3,
    price: "₹8,500/mo",
    priceNum: 8500,
    icon: "database",
    features: [],
  },
  {
    id: "lead-gen",
    name: "Lead Gen Engine",
    category: "leadgen",
    categoryLabel: "Lead Gen",
    status: "ACTIVE",
    badge: null,
    description: "Multi-channel lead generation and qualification.",
    tags: ["LEAD GEN", "ONGOING"],
    revenue: 220000,
    clients: 74,
    leads: 6200,
    converted: 920,
    convRate: 14.8,
    price: "₹5,000/mo",
    priceNum: 5000,
    icon: "target",
    features: [],
  },
];

const FORMS = [
  {
    id: "google-ads",
    name: "Google Ads Form",
    source: "Google Ads",
    sourceKey: "google_ads",
    status: "ACTIVE",
    leads: 1284,
    revenue: 425000,
    conversion: 18,
    service: "AI Automation",
    fields: [],
  },
  {
    id: "instagram-leads",
    name: "Instagram Leads",
    source: "Instagram",
    sourceKey: "instagram",
    status: "ACTIVE",
    leads: 842,
    revenue: 218000,
    conversion: 14,
    service: "Lead Gen",
    fields: [],
  },
  {
    id: "website-contact",
    name: "Website Contact",
    source: "Website",
    sourceKey: "website",
    status: "PAUSED",
    leads: 456,
    revenue: 98000,
    conversion: 11,
    service: "CRM Setup",
    fields: [],
  },
];

const DEFAULT_SETTINGS = {
  profile: {
    fullName: "Alex Chen",
    role: "Super Admin",
    email: "alex.chen@tspublication.in",
    phone: "+91 98765 43210",
    timezone: "Asia/Kolkata (IST)",
  },
  auth: { provider: "google", passwordLoginEnabled: false, googleConnected: false, googleEmail: "" },
  notifications: { emailNotifications: true, leadAssigned: true, meetingReminder: true, targetAchieved: false, weeklyDigest: true },
  appearance: { theme: "Crimson Noir", sidebarCollapsed: false },
  employeeTargets: [
    { id: 1, name: "Sarah Chen", team: "Sales & Growth", calls: 450, leads: 45, meetings: 35, revenue: 145000 },
    { id: 2, name: "James Wilson", team: "Enterprise Sales", calls: 390, leads: 39, meetings: 30, revenue: 118000 },
  ],
  kpiWeights: [
    { id: "revenue", label: "Cash Collected / Revenue", weight: 35, enabled: true },
    { id: "leads", label: "Converted Leads", weight: 25, enabled: true },
    { id: "meetings", label: "Completed Meetings", weight: 20, enabled: true },
    { id: "calls", label: "Call Volume Completed", weight: 20, enabled: true },
  ],
  incentiveSlabs: [
    { id: 1, tier: "Bronze", min: 0, max: 100000, rate: 3 },
    { id: 2, tier: "Silver", min: 100000, max: 250000, rate: 4.5 },
    { id: 3, tier: "Gold", min: 250000, max: 400000, rate: 6 },
    { id: 4, tier: "Platinum", min: 400000, max: 1000000, rate: 8 },
  ],
  baseIncentiveRate: 2.5,
  targetBonusAmount: 2500,
  formulaType: "weighted",
  ratingThresholds: { outstanding: 110, excellent: 100, good: 85, average: 70 },
  currentVersion: "v2.3",
};

module.exports = {
  FILTER_DATA,
  revenueSeries,
  aiInsights,
  SERVICES,
  FORMS,
  DEFAULT_SETTINGS,
};
