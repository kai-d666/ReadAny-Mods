/**
 * Reading Stats service — computes reading statistics from session data
 */
import {
  getBooks,
  getReadingSessions,
  getReadingSessionsByDateRange,
  getReadingSessionsDaily,
  getReadingSessionSummary,
} from "../db/database";

export interface DailyStats {
  date: string; // YYYY-MM-DD
  totalTime: number; // minutes
  pagesRead: number;
  charactersRead?: number;
  sessionsCount: number;
}

export interface BookStats {
  bookId: string;
  bookTitle: string;
  totalTime: number; // minutes
  sessions: number;
  avgSessionTime: number; // minutes
  pagesRead: number;
  charactersRead?: number;
}

export interface OverallStats {
  totalBooks: number;
  totalReadingTime: number; // minutes
  totalCharactersRead?: number;
  avgCharactersPerMinute?: number;
  totalSessions: number;
  totalReadingDays: number; // days
  avgDailyTime: number; // minutes
  longestStreak: number; // days
  currentStreak: number; // days
}

export interface PeriodBookStats {
  bookId: string;
  title: string;
  author: string;
  coverUrl?: string;
  totalTime: number; // minutes
  /** 当前进度展示走 getProgressPercent(fileHash)(唯一账本 reading_progress) */
  fileHash?: string;
}

export interface TrendPoint {
  date: string; // YYYY-MM-DD
  dailyTime: number; // minutes
  cumulativeTime: number; // minutes
}

export class ReadingStatsService {
  /** Get daily reading stats for a date range */
  async getDailyStats(startDate: Date, endDate: Date): Promise<DailyStats[]> {
    // SQL 端 GROUP BY 聚合:全量行 JSON 跨桥 → 每日一行(拉 365 天也才 ≤365 行)
    const rows = await getReadingSessionsDaily(startDate.getTime(), endDate.getTime());
    const byDate = new Map(rows.map((r) => [r.date, r]));

    // Fill in missing days with zeros
    const result: DailyStats[] = [];
    const current = new Date(startDate);
    while (current <= endDate) {
      const dateStr = current.toISOString().split("T")[0];
      const g = byDate.get(dateStr);
      result.push(
        g
          ? {
              date: g.date,
              totalTime: g.totalActiveTimeMs / 60000,
              pagesRead: g.pagesRead,
              charactersRead: g.charactersRead,
              sessionsCount: g.sessionsCount,
            }
          : {
              date: dateStr,
              totalTime: 0,
              pagesRead: 0,
              charactersRead: 0,
              sessionsCount: 0,
            },
      );
      current.setDate(current.getDate() + 1);
    }

    return result;
  }

  /** Get stats for a specific book */
  async getBookStats(bookId: string): Promise<BookStats> {
    const sessions = await getReadingSessions(bookId);
    const books = await getBooks({ includeDeleted: true });
    const book = books.find((b) => b.id === bookId);

    const totalTime = sessions.reduce((sum, s) => sum + s.totalActiveTime, 0);

    return {
      bookId,
      bookTitle: book?.meta.title || "Unknown",
      totalTime: totalTime / 60000,
      sessions: sessions.length,
      avgSessionTime: sessions.length > 0 ? totalTime / sessions.length / 60000 : 0,
      pagesRead: sessions.reduce((sum, s) => sum + s.pagesRead, 0),
      charactersRead: sessions.reduce((sum, s) => sum + (s.charactersRead ?? 0), 0),
    };
  }

  /** Get overall reading statistics */
  async getOverallStats(): Promise<OverallStats> {
    // 单次聚合查询代替原 N+1 逐本遍历(每本书一次 SELECT,实测 ~400ms)
    const summary = await getReadingSessionSummary();

    // Calculate streaks
    const { longestStreak, currentStreak } = this.calculateStreaks(new Set(summary.readingDays));

    const daysCount = summary.readingDays.length || 1;

    return {
      totalBooks: summary.totalBooksStarted,
      totalReadingTime: summary.totalActiveTimeMs / 60000,
      totalCharactersRead: summary.totalCharactersRead,
      avgCharactersPerMinute:
        summary.totalActiveTimeMs > 0
          ? summary.totalCharactersRead / (summary.totalActiveTimeMs / 60000)
          : 0,
      totalSessions: summary.totalSessions,
      totalReadingDays: summary.readingDays.length,
      avgDailyTime: summary.totalActiveTimeMs / 60000 / daysCount,
      longestStreak,
      currentStreak,
    };
  }

  /** Get weekly stats (7 days starting from weekStart, which should be a Monday) */
  async getWeeklyStats(weekStart: Date): Promise<DailyStats[]> {
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);
    return this.getDailyStats(weekStart, weekEnd);
  }

  /** Get monthly stats (all days in a given month) */
  async getMonthlyStats(year: number, month: number): Promise<DailyStats[]> {
    const start = new Date(year, month, 1);
    const end = new Date(year, month + 1, 0); // last day of month
    end.setHours(23, 59, 59, 999);
    return this.getDailyStats(start, end);
  }

  /** Get per-book reading time for a date range */
  async getBookStatsForPeriod(start: Date, end: Date): Promise<PeriodBookStats[]> {
    const sessions = await getReadingSessionsByDateRange(start, end);
    const books = await getBooks({ includeDeleted: true });
    const bookMap = new Map(books.map((b) => [b.id, b]));

    // Group reading time by book
    const timeByBook = new Map<string, number>();
    for (const session of sessions) {
      const existing = timeByBook.get(session.bookId) || 0;
      timeByBook.set(session.bookId, existing + session.totalActiveTime);
    }

    // Build results sorted by total time descending
    const results: PeriodBookStats[] = [];
    for (const [bookId, totalMs] of timeByBook) {
      const book = bookMap.get(bookId);
      if (!book) continue;
      results.push({
        bookId,
        title: book.meta.title,
        author: book.meta.author,
        coverUrl: book.meta.coverUrl,
        totalTime: totalMs / 60000,
        fileHash: book.fileHash,
      });
    }

    return results.sort((a, b) => b.totalTime - a.totalTime);
  }

  /** Get recent trend data (daily + cumulative) for the last N days */
  async getRecentTrend(days: number): Promise<TrendPoint[]> {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days + 1);
    start.setHours(0, 0, 0, 0);

    const daily = await this.getDailyStats(start, end);
    let cumulative = 0;
    return daily.map((d) => {
      cumulative += d.totalTime;
      return {
        date: d.date,
        dailyTime: d.totalTime,
        cumulativeTime: cumulative,
      };
    });
  }

  /** Calculate reading streaks from a set of reading dates */
  private calculateStreaks(readingDays: Set<string>): {
    longestStreak: number;
    currentStreak: number;
  } {
    if (readingDays.size === 0) {
      return { longestStreak: 0, currentStreak: 0 };
    }

    const sortedDates = Array.from(readingDays).sort();

    let longestStreak = 1;
    let currentStreakCount = 1;
    let tempStreak = 1;

    for (let i = 1; i < sortedDates.length; i++) {
      const prev = new Date(sortedDates[i - 1]);
      const curr = new Date(sortedDates[i]);
      const diffDays = Math.round((curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24));

      if (diffDays === 1) {
        tempStreak++;
      } else {
        tempStreak = 1;
      }

      longestStreak = Math.max(longestStreak, tempStreak);
    }

    // Check if current streak is active (includes today or yesterday)
    const today = new Date().toISOString().split("T")[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

    if (readingDays.has(today) || readingDays.has(yesterday)) {
      // Count backwards from the most recent date
      currentStreakCount = 1;
      const reversed = sortedDates.reverse();
      for (let i = 1; i < reversed.length; i++) {
        const curr = new Date(reversed[i - 1]);
        const prev = new Date(reversed[i]);
        const diffDays = Math.round((curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays === 1) {
          currentStreakCount++;
        } else {
          break;
        }
      }
    } else {
      currentStreakCount = 0;
    }

    return { longestStreak, currentStreak: currentStreakCount };
  }
}

/** Singleton stats service */
export const readingStatsService = new ReadingStatsService();
