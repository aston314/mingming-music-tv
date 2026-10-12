package com.aston.mingmingmusic;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.view.Gravity;
import android.view.View;
import android.view.animation.LinearInterpolator;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Native startup UI remains above the WebView until the local page is ready. */
final class StartupView extends LinearLayout {
    private final LogoRingView logo;
    private final TextView status;
    private final Button retry;
    private boolean loading = true;

    StartupView(Context context, final Runnable onRetry) {
        super(context);
        setOrientation(VERTICAL);
        setGravity(Gravity.CENTER);
        setBackgroundColor(Color.rgb(16, 23, 19));
        logo = new LogoRingView(context);
        addView(logo, new LayoutParams(dp(148), dp(148)));
        TextView title = text("正在启动" + context.getString(R.string.app_name) + "...", 28, Color.WHITE);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        LayoutParams titleParams = new LayoutParams(-2, -2);
        titleParams.topMargin = dp(24);
        addView(title, titleParams);
        TextView version = text("v" + BuildConfig.VERSION_NAME, 16, Color.rgb(159, 177, 163));
        LayoutParams versionParams = new LayoutParams(-2, -2);
        versionParams.topMargin = dp(8);
        addView(version, versionParams);
        status = text("正在准备音乐服务", 16, Color.rgb(159, 177, 163));
        LayoutParams statusParams = new LayoutParams(-2, -2);
        statusParams.topMargin = dp(22);
        addView(status, statusParams);
        retry = new Button(context);
        retry.setText("重新启动");
        retry.setTextSize(18);
        retry.setVisibility(GONE);
        retry.setOnClickListener(new OnClickListener() {
            @Override public void onClick(View view) { onRetry.run(); }
        });
        LayoutParams retryParams = new LayoutParams(-2, -2);
        retryParams.topMargin = dp(16);
        addView(retry, retryParams);
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private TextView text(String value, int size, int color) {
        TextView view = new TextView(getContext());
        view.setText(value); view.setTextSize(size); view.setTextColor(color); view.setGravity(Gravity.CENTER);
        return view;
    }
    void setStatus(String message, boolean isLoading) {
        status.setText(message); loading = isLoading;
        retry.setVisibility(isLoading ? GONE : VISIBLE);
        logo.setRunning(isLoading);
        if (!isLoading) retry.requestFocus();
    }
    void pauseAnimation() { logo.setRunning(false); }
    void resumeAnimation() { logo.setRunning(loading && getVisibility() == VISIBLE); }

    private static final class LogoRingView extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF ring = new RectF();
        private final Drawable drawable;
        private final ValueAnimator animator;
        private float phase;
        private boolean running = true;

        LogoRingView(Context context) {
            super(context);
            drawable = context.getDrawable(R.drawable.ic_launcher);
            setContentDescription(context.getString(R.string.app_name) + " Logo");
            animator = ValueAnimator.ofFloat(0f, 1f);
            animator.setDuration(1600);
            animator.setRepeatCount(ValueAnimator.INFINITE);
            animator.setInterpolator(new LinearInterpolator());
            animator.addUpdateListener(new ValueAnimator.AnimatorUpdateListener() {
                @Override public void onAnimationUpdate(ValueAnimator value) {
                    phase = (Float) value.getAnimatedValue(); invalidate();
                }
            });
        }
        void setRunning(boolean value) {
            running = value;
            if (value && isAttachedToWindow()) { if (!animator.isStarted()) animator.start(); }
            else animator.cancel();
            invalidate();
        }
        @Override protected void onAttachedToWindow() { super.onAttachedToWindow(); setRunning(running); }
        @Override protected void onDetachedFromWindow() { animator.cancel(); super.onDetachedFromWindow(); }
        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            float size = Math.min(getWidth(), getHeight()), cx = getWidth() / 2f, cy = getHeight() / 2f;
            float radius = size * .46f;
            ring.set(cx - radius, cy - radius, cx + radius, cy + radius);
            paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(size * .027f); paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setColor(Color.rgb(43, 61, 48)); canvas.drawOval(ring, paint);
            if (running) {
                paint.setColor(Color.rgb(199, 243, 141));
                float sweep = 75f + 75f * (float) Math.sin(phase * Math.PI);
                canvas.drawArc(ring, phase * 360f - 90f, sweep, false, paint);
            }
            // Leave space between the square logo's corners and the round ring.
            int half = Math.round(size * .28f);
            drawable.setBounds(Math.round(cx) - half, Math.round(cy) - half, Math.round(cx) + half, Math.round(cy) + half);
            drawable.draw(canvas);
        }
    }
}
