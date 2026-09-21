"""Smart Water Analyzer - Flask backend.

Linear Regression -> predicted total consumption
CART              -> usage level (Low / Medium / High)
Rules             -> tips, recommended limit
Daily rewards     -> points per day based on daily water wastage (+ goal bonus)
Extras            -> usage history, monthly bill estimate, savings goal,
                     weekly/monthly leaderboard, model insights page
"""
import calendar
import os
import re
import threading
from datetime import date, timedelta

import pandas as pd
from flask import Flask, jsonify, render_template, request
from sklearn.linear_model import LinearRegression
from sklearn.metrics import accuracy_score, confusion_matrix, mean_absolute_error, r2_score
from sklearn.model_selection import train_test_split
from sklearn.tree import DecisionTreeClassifier, export_text

BASE = os.path.dirname(os.path.abspath(__file__))
FEATURES = ["Bathroom", "Kitchen", "Laundry", "Gardening"]
LEVELS = ["Low", "Medium", "High"]

USERS_FILE = os.path.join(BASE, "data", "users.csv")
USER_COLS = ["username", "points", "days_logged", "streak", "last_date",
             "last_total", "last_wastage", "last_level"]
LOG_FILE = os.path.join(BASE, "data", "daily_log.csv")
LOG_COLS = ["date", "username", "total", "wastage", "level",
            "usage_pts", "reduction_pts", "streak_pts", "goal_pts", "points"]
GOALS_FILE = os.path.join(BASE, "data", "goals.csv")
GOAL_COLS = ["username", "daily_goal"]

app = Flask(__name__)
lock = threading.Lock()

# ---------- Load the cleaned dataset and train the models ----------
# water_consumption_clean.csv is produced by water_consumption.ipynb (preprocessing part).
CLEAN_CSV = os.path.join(BASE, "dataset", "water_consumption_clean.csv")
if not os.path.exists(CLEAN_CSV):
    raise SystemExit("dataset/water_consumption_clean.csv not found. Run water_consumption.ipynb first.")
dataset = pd.read_csv(CLEAN_CSV)

# Same models and settings as the notebook, trained on all cleaned rows
lr_model = LinearRegression().fit(dataset[FEATURES], dataset["Total"])
cart_model = DecisionTreeClassifier(criterion="gini", max_depth=6, random_state=42).fit(
    dataset[FEATURES], dataset["Level"])

AVG = dataset[FEATURES].mean().round(1).to_dict()
AVG_TOTAL = round(float(dataset["Total"].mean()), 1)
MAX_SCALE = round(float(dataset["Total"].quantile(0.99)) * 1.15)
# Efficient-use benchmark: the 33rd percentile of daily totals (the "Low" band).
# Any litres above this on a given day count as that day's wastage.
BENCHMARK = round(float(dataset["Total"].quantile(0.33)), 1)


def build_model_info():
    """Evaluate both models on a held-out 20% test set (same split as the notebook)."""
    X, y = dataset[FEATURES], dataset["Total"]
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.2, random_state=42)
    lr_eval = LinearRegression().fit(Xtr, ytr)
    pred = lr_eval.predict(Xte)

    Xc_tr, Xc_te, yc_tr, yc_te = train_test_split(
        X, dataset["Level"], test_size=0.2, random_state=42, stratify=dataset["Level"])
    cart_eval = DecisionTreeClassifier(criterion="gini", max_depth=6, random_state=42).fit(Xc_tr, yc_tr)
    pred_c = cart_eval.predict(Xc_te)

    return {
        "rows": int(len(dataset)),
        "test_rows": int(len(Xte)),
        "avg_total": AVG_TOTAL,
        "benchmark": BENCHMARK,
        "levels": {k: int(v) for k, v in dataset["Level"].value_counts().items()},
        "linear": {
            "r2": round(float(r2_score(yte, pred)), 4),
            "mae": round(float(mean_absolute_error(yte, pred)), 2),
            "intercept": round(float(lr_model.intercept_), 2),
            "coefs": {f: round(float(c), 3) for f, c in zip(FEATURES, lr_model.coef_)},
        },
        "cart": {
            "accuracy": round(float(accuracy_score(yc_te, pred_c)), 3),
            "depth": int(cart_model.get_depth()),
            "leaves": int(cart_model.get_n_leaves()),
            "labels": LEVELS,
            "matrix": confusion_matrix(yc_te, pred_c, labels=LEVELS).tolist(),
            "importance": {f: round(float(i), 3) for f, i in zip(FEATURES, cart_model.feature_importances_)},
            "rules": export_text(cart_model, feature_names=FEATURES, max_depth=3),
        },
    }


MODEL_INFO = build_model_info()

# ---------- Rule base ----------
TIPS = {
    "Bathroom": [
        "Keep showers under 5 minutes and turn the tap off while soaping.",
        "Fit a low-flow showerhead and fix any leaking taps or toilet cisterns.",
        "Turn the tap off while brushing your teeth or shaving.",
    ],
    "Kitchen": [
        "Wash vegetables in a bowl instead of under a running tap.",
        "Run the dishwasher only with a full load, and skip pre-rinsing.",
        "Reuse the water from rinsing vegetables to water plants.",
    ],
    "Laundry": [
        "Wash full loads only and pick the eco cycle on your machine.",
        "Use the right water level setting for the load size.",
        "Reuse the final rinse water for mopping floors.",
    ],
    "Gardening": [
        "Water early in the morning or late evening to reduce evaporation.",
        "Use drip irrigation or a watering can instead of a hose.",
        "Add mulch around plants and collect rainwater in a barrel.",
    ],
}
MAX_USAGE_PTS = 50      # full marks when there is no wastage
MAX_REDUCTION_PTS = 30  # bonus for using less than the previous day
STREAK_STEP = 5         # per extra consecutive zero-wastage day
MAX_STREAK_STEPS = 5
GOAL_PTS = 10           # bonus for staying within the user's own daily goal
BADGES = [(500, "Water Champion"), (250, "Water Guardian"), (100, "Water Saver"), (0, "Beginner")]


def badge_for(points):
    return next(name for limit, name in BADGES if points >= limit)


# ---------- Storage ----------
def today():
    return date.today()


def load_users():
    if not os.path.exists(USERS_FILE) or os.path.getsize(USERS_FILE) == 0:
        return pd.DataFrame(columns=USER_COLS)
    df = pd.read_csv(USERS_FILE)
    return df if list(df.columns) == USER_COLS else pd.DataFrame(columns=USER_COLS)


def save_users(df):
    df.to_csv(USERS_FILE, index=False)


def load_log():
    if not os.path.exists(LOG_FILE) or os.path.getsize(LOG_FILE) == 0:
        return pd.DataFrame(columns=LOG_COLS)
    df = pd.read_csv(LOG_FILE)
    for col in LOG_COLS:          # older logs without the goal column keep working
        if col not in df.columns:
            df[col] = 0
    return df[LOG_COLS]


def save_log(df):
    df.to_csv(LOG_FILE, index=False)


def load_goals():
    if not os.path.exists(GOALS_FILE) or os.path.getsize(GOALS_FILE) == 0:
        return pd.DataFrame(columns=GOAL_COLS)
    return pd.read_csv(GOALS_FILE)


def get_goal(username):
    goals = load_goals()
    row = goals[goals["username"].str.lower() == username.lower()]
    return float(row.iloc[0]["daily_goal"]) if len(row) else None


def user_log(log, username):
    return log[log["username"].str.lower() == username.lower()]


def clean_name(raw):
    name = re.sub(r"[^A-Za-z0-9 _.-]", "", str(raw or "")).strip()
    return name[:20]


def build_recommendations(values, level):
    """Rule-based tips. An area is 'high' when it is 20% above the dataset average."""
    ratios = {a: values[a] / AVG[a] if AVG[a] else 0 for a in FEATURES}
    ordered = sorted(FEATURES, key=lambda a: ratios[a], reverse=True)
    high_areas = [a for a in ordered if ratios[a] > 1.2]

    tips = []
    for area in high_areas:
        idx = 0 if ratios[area] < 1.5 else 1
        tips.append({"area": area, "tip": TIPS[area][idx], "ratio": round(ratios[area], 2)})
    if not tips and level != "Low":
        top = ordered[0]
        tips.append({"area": top, "tip": TIPS[top][2], "ratio": round(ratios[top], 2)})
    return ordered[0], high_areas, tips


def score_day(user_rows, day, total, goal=None):
    """Daily reward = usage points + reduction bonus + streak bonus + goal bonus.

    wastage       = litres above the efficient benchmark (never negative)
    usage points  = 50 with no wastage, falling to 0 as wastage reaches the benchmark
    reduction     = 2 points per 1% saved versus the previous logged day (max 30)
    streak bonus  = +5 for each extra consecutive day with zero wastage (max 25)
    goal bonus    = +10 when the day's total is within the user's own daily goal
    """
    day_str = day.isoformat()
    wastage = max(0.0, total - BENCHMARK)
    usage_pts = max(0, round(MAX_USAGE_PTS * (1 - wastage / BENCHMARK)))

    earlier = user_rows[user_rows["date"] < day_str].sort_values("date")
    reduction_pct, reduction_pts = 0.0, 0
    if len(earlier):
        prev_total = float(earlier.iloc[-1]["total"])
        if prev_total > 0 and total < prev_total:
            reduction_pct = (prev_total - total) / prev_total * 100
            reduction_pts = min(int(reduction_pct * 2), MAX_REDUCTION_PTS)

    streak = 0
    if wastage == 0:
        zero_days = set(user_rows.loc[user_rows["wastage"] == 0, "date"])
        streak, d = 1, day - timedelta(days=1)
        while d.isoformat() in zero_days:
            streak += 1
            d -= timedelta(days=1)
    streak_pts = min(max(streak - 1, 0), MAX_STREAK_STEPS) * STREAK_STEP

    goal_met = bool(goal) and total <= goal
    goal_pts = GOAL_PTS if goal_met else 0

    return {"wastage": round(wastage, 1), "usage_pts": usage_pts,
            "reduction_pts": reduction_pts, "reduction_pct": round(reduction_pct, 1),
            "streak": streak, "streak_pts": streak_pts,
            "goal_met": goal_met, "goal_pts": goal_pts,
            "points": usage_pts + reduction_pts + streak_pts + goal_pts}


# ---------- Pages ----------
@app.route("/")
def index():
    return render_template("index.html", avg=AVG, avg_total=AVG_TOTAL, benchmark=BENCHMARK)


@app.route("/model")
def model_page():
    return render_template("metrics.html", info=MODEL_INFO)


# ---------- API: predict + rewards ----------
@app.route("/api/predict", methods=["POST"])
def predict():
    data = request.get_json(silent=True) or {}
    username = clean_name(data.get("username"))
    if not username:
        return jsonify(error="Enter a name to track your points."), 400

    try:
        values = {a: float(data.get(a.lower(), 0)) for a in FEATURES}
    except (TypeError, ValueError):
        return jsonify(error="Usage values must be numbers."), 400
    if any(v < 0 or v > 5000 for v in values.values()):
        return jsonify(error="Usage values must be between 0 and 5000 litres."), 400

    row = pd.DataFrame([values])[FEATURES]
    predicted = float(lr_model.predict(row)[0])
    level = str(cart_model.predict(row)[0])
    actual_total = sum(values.values())

    top_area, high_areas, tips = build_recommendations(values, level)

    if level == "High":
        target = AVG_TOTAL
        advice = "Cut back to about the household average."
    elif level == "Medium":
        target = predicted * 0.9
        advice = "A 10% reduction would move you into the Low band."
    else:
        target = predicted
        advice = "Great habits. Keep your usage where it is."

    # Daily reward: one scored entry per user per day
    day = today()
    day_str = day.isoformat()
    with lock:
        goal = get_goal(username)
        log = load_log()
        mine = log["username"].str.lower() == username.lower()
        already_logged = bool(((log["date"] == day_str) & mine).any())
        sc = score_day(log[mine], day, actual_total, goal)

        # Re-logging on the same day replaces that day's entry (no extra points)
        log = log[~((log["date"] == day_str) & mine)]
        log.loc[len(log)] = [day_str, username, round(actual_total, 1), sc["wastage"], level,
                             sc["usage_pts"], sc["reduction_pts"], sc["streak_pts"],
                             sc["goal_pts"], sc["points"]]
        save_log(log)

        mine = log["username"].str.lower() == username.lower()
        total_points = int(log.loc[mine, "points"].sum())
        days_logged = int(mine.sum())

        users = load_users()
        urow = [username, total_points, days_logged, sc["streak"], day_str,
                round(actual_total, 1), sc["wastage"], level]
        idx = users.index[users["username"].str.lower() == username.lower()]
        if len(idx):
            users.loc[idx[0]] = urow
        else:
            users.loc[len(users)] = urow
        save_users(users)

    return jsonify(
        username=username,
        predicted=round(predicted, 1),
        actual_total=round(actual_total, 1),
        level=level,
        top_area=top_area,
        high_areas=high_areas,
        tips=tips,
        breakdown=[{"area": a, "value": values[a], "avg": AVG[a]} for a in FEATURES],
        recommended={"limit": round(target, 1), "advice": advice},
        benchmark=BENCHMARK,
        wastage=sc["wastage"],
        rewards={"usage": sc["usage_pts"], "reduction": sc["reduction_pts"],
                 "reduction_pct": sc["reduction_pct"], "streak": sc["streak"],
                 "streak_bonus": sc["streak_pts"], "goal_bonus": sc["goal_pts"],
                 "goal": {"set": goal is not None, "target": goal, "met": sc["goal_met"]},
                 "earned": sc["points"], "total": total_points,
                 "badge": badge_for(total_points), "updated": already_logged},
        scale=MAX_SCALE,
        avg_total=AVG_TOTAL,
    )


# ---------- API: history, monthly summary, goal ----------
@app.route("/api/history")
def history():
    user = clean_name(request.args.get("user"))
    mine = user_log(load_log(), user).sort_values("date").tail(30)
    days = [{"date": r.date, "total": float(r.total), "wastage": float(r.wastage),
             "points": int(r.points), "level": r.level} for r in mine.itertuples()]
    return jsonify(days=days, benchmark=BENCHMARK, goal=get_goal(user))


@app.route("/api/summary")
def summary():
    user = clean_name(request.args.get("user"))
    t = today()
    mine = user_log(load_log(), user)
    month_rows = mine[mine["date"].str.startswith(t.strftime("%Y-%m"))]
    goal = get_goal(user)
    days_in_month = calendar.monthrange(t.year, t.month)[1]

    out = {"has_data": len(month_rows) > 0, "goal": goal, "benchmark": BENCHMARK,
           "days_in_month": days_in_month, "today_total": None,
           "goal_days_met": 0, "goal_streak": 0}

    today_row = mine[mine["date"] == t.isoformat()]
    if len(today_row):
        out["today_total"] = float(today_row.iloc[0]["total"])

    if len(month_rows):
        month_total = float(month_rows["total"].sum())
        avg_daily = month_total / len(month_rows)
        projected = avg_daily * days_in_month
        out.update(
            days_logged=int(len(month_rows)),
            month_total=round(month_total, 1),
            avg_daily=round(avg_daily, 1),
            projected=round(projected, 1),
            projected_at_benchmark=round(BENCHMARK * days_in_month, 1),
            potential_saving=round(max(0.0, projected - BENCHMARK * days_in_month), 1),
        )

    if goal:
        met_days = set(mine.loc[mine["total"] <= goal, "date"])
        out["goal_days_met"] = int(month_rows["total"].le(goal).sum()) if len(month_rows) else 0
        d = t if t.isoformat() in set(mine["date"]) else t - timedelta(days=1)
        streak = 0
        while d.isoformat() in met_days:
            streak += 1
            d -= timedelta(days=1)
        out["goal_streak"] = streak
    return jsonify(out)


@app.route("/api/goal", methods=["POST"])
def set_goal():
    data = request.get_json(silent=True) or {}
    user = clean_name(data.get("username"))
    if not user:
        return jsonify(error="Enter your name first."), 400
    try:
        goal = float(data.get("goal"))
    except (TypeError, ValueError):
        return jsonify(error="Enter your goal in litres."), 400
    if goal != 0 and not 50 <= goal <= 5000:
        return jsonify(error="Goal must be between 50 and 5000 litres (0 removes it)."), 400

    with lock:
        goals = load_goals()
        goals = goals[goals["username"].str.lower() != user.lower()]
        if goal > 0:
            goals.loc[len(goals)] = [user, round(goal, 1)]
        goals.to_csv(GOALS_FILE, index=False)
    return jsonify(goal=goal or None)


# ---------- API: leaderboard ----------
def period_start(period):
    t = today()
    if period == "week":
        return (t - timedelta(days=t.weekday())).isoformat()   # this Monday
    if period == "month":
        return t.replace(day=1).isoformat()
    return None


@app.route("/api/leaderboard")
def leaderboard():
    period = request.args.get("period", "all")
    users = load_users()
    if users.empty:
        return jsonify(leaders=[], period=period)
    info = {r.username: r for r in users.itertuples()}

    if period in ("week", "month"):
        log = load_log()
        log = log[log["date"] >= period_start(period)]
        if log.empty:
            return jsonify(leaders=[], period=period)
        g = log.groupby("username").agg(points=("points", "sum"), days=("date", "count")).reset_index()
        g = g.sort_values(["points", "days"], ascending=[False, True]).head(10)
        leaders = []
        for n, r in enumerate(g.itertuples()):
            u = info.get(r.username)
            leaders.append({"rank": n + 1, "username": r.username, "points": int(r.points),
                            "level": u.last_level if u else "Low", "streak": int(u.streak) if u else 0,
                            "days": int(r.days), "badge": badge_for(int(u.points)) if u else "Beginner"})
        return jsonify(leaders=leaders, period=period)

    users = users.sort_values(["points", "days_logged"], ascending=[False, True]).head(10)
    leaders = [
        {"rank": n + 1, "username": r.username, "points": int(r.points),
         "level": r.last_level, "streak": int(r.streak), "days": int(r.days_logged),
         "badge": badge_for(int(r.points))}
        for n, r in enumerate(users.itertuples())
    ]
    return jsonify(leaders=leaders, period=period)


# ---------- API: model insights ----------
@app.route("/api/model-info")
def model_info():
    return jsonify(MODEL_INFO)


if __name__ == "__main__":
    for path, cols in [(USERS_FILE, USER_COLS), (LOG_FILE, LOG_COLS), (GOALS_FILE, GOAL_COLS)]:
        if not os.path.exists(path) or os.path.getsize(path) == 0:
            pd.DataFrame(columns=cols).to_csv(path, index=False)
    app.run(debug=True)
