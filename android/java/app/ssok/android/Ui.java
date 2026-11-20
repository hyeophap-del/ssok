package app.ssok.android;

import android.app.Activity;
import android.content.Context;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** 화면을 코드로 만드는 작은 도구 (레이아웃 XML 없이) */
final class Ui {
    private Ui() {}

    static int dp(Context c, float value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, c.getResources().getDisplayMetrics()));
    }

    static int color(Context c, int id) {
        return c.getColor(id);
    }

    /** 스크롤되는 세로 화면. 돌려주는 LinearLayout에 내용을 넣는다. */
    static LinearLayout page(Activity activity) {
        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        LinearLayout column = new LinearLayout(activity);
        column.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(activity, 20);
        column.setPadding(pad, dp(activity, 28), pad, pad);
        scroll.addView(column, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        activity.setContentView(scroll);
        scroll.setOnApplyWindowInsetsListener((v, insets) -> {
            v.setPadding(0, insets.getSystemWindowInsetTop(), 0, insets.getSystemWindowInsetBottom());
            return insets;
        });
        return column;
    }

    static TextView title(Context c, String text) {
        TextView view = text(c, text, 24, R.color.text);
        view.setTypeface(Typeface.DEFAULT_BOLD);
        return view;
    }

    static TextView heading(Context c, String text) {
        TextView view = text(c, text, 16, R.color.text);
        view.setTypeface(Typeface.DEFAULT_BOLD);
        return view;
    }

    static TextView body(Context c, String text) {
        return text(c, text, 15, R.color.text);
    }

    static TextView muted(Context c, String text) {
        return text(c, text, 13, R.color.muted);
    }

    static TextView text(Context c, String text, float sp, int colorId) {
        TextView view = new TextView(c);
        view.setText(text);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        view.setTextColor(color(c, colorId));
        view.setLineSpacing(0, 1.25f);
        return view;
    }

    /** 확인 숫자처럼 크게 보여 줄 글자 */
    static TextView big(Context c, String text) {
        TextView view = text(c, text, 40, R.color.accent);
        view.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        view.setLetterSpacing(0.15f);
        view.setGravity(Gravity.CENTER);
        return view;
    }

    static Button button(Context c, String text, boolean primary, View.OnClickListener onClick) {
        Button button = new Button(c);
        button.setText(text);
        button.setAllCaps(false);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(c, 12));
        if (primary) {
            bg.setColor(color(c, R.color.accent));
            button.setTextColor(color(c, R.color.surface));
        } else {
            bg.setColor(color(c, R.color.surface));
            bg.setStroke(dp(c, 1), color(c, R.color.border));
            button.setTextColor(color(c, R.color.text));
        }
        button.setBackground(bg);
        button.setPadding(dp(c, 16), dp(c, 10), dp(c, 16), dp(c, 10));
        button.setOnClickListener(onClick);
        return button;
    }

    /** 흰 바탕에 둥근 모서리 카드 */
    static LinearLayout card(Context c) {
        LinearLayout card = new LinearLayout(c);
        card.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(c, 16);
        card.setPadding(pad, pad, pad, pad);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(c, 18));
        bg.setColor(color(c, R.color.surface));
        bg.setStroke(dp(c, 1), color(c, R.color.border));
        card.setBackground(bg);
        return card;
    }

    static void add(LinearLayout parent, View child, int topMarginDp) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(parent.getContext(), topMarginDp);
        parent.addView(child, params);
    }
}
