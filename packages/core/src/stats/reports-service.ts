import type { Book, ReadingSession } from "../types";
import { getAllReadingSessions, getBooks } from "../db";
import { getProgressProjectionMap } from "../db/progress-queries";
import { buildDailyReadingFacts } from "./fact-builder";
import { mergeCurrentSessionIntoDailyFacts } from "./live-facts";
import {
  buildDayReport,
  buildLifetimeReport,
  buildMonthReport,
  buildWeekReport,
  buildYearReport,
} from "./report-builder";
import type {
  DailyReadingFact,
  DayReport,
  LifetimeReport,
  MonthReport,
  WeekReport,
  YearReport,
} from "./schema";

export class ReadingReportsService {
  /**
   * 统计链进度修正(2026-09-07):books.progress 已废弃(移动端阅读不再更新它),
   * fact-builder/live-facts/report-builder 是纯函数,这里在入口处用唯一账本
   * reading_progress 覆盖 Book.progress → progressEnd/ETA/已读计数全部基于新账本。
   */
  private async withLedgerProgress(books: Book[]): Promise<Book[]> {
    const projection = await getProgressProjectionMap();
    return books.map((b) => {
      const entry = b.fileHash ? projection.get(b.fileHash) : undefined;
      return entry !== undefined ? { ...b, progress: entry.percent } : b;
    });
  }

  async getAllDailyFacts(currentSession: ReadingSession | null = null): Promise<DailyReadingFact[]> {
    const [rawBooks, sessions] = await Promise.all([getBooks({ includeDeleted: true }), getAllReadingSessions()]);
    const books = await this.withLedgerProgress(rawBooks);
    const facts = buildDailyReadingFacts(sessions, books);
    return mergeCurrentSessionIntoDailyFacts(facts, currentSession, books);
  }

  async getDayReport(date: Date, currentSession: ReadingSession | null = null): Promise<DayReport> {
    const facts = await this.getAllDailyFacts(currentSession);
    return buildDayReport(facts, date);
  }

  async getWeekReport(date: Date, currentSession: ReadingSession | null = null): Promise<WeekReport> {
    const facts = await this.getAllDailyFacts(currentSession);
    return buildWeekReport(facts, date);
  }

  async getMonthReport(date: Date, currentSession: ReadingSession | null = null): Promise<MonthReport> {
    const facts = await this.getAllDailyFacts(currentSession);
    return buildMonthReport(facts, date);
  }

  async getYearReport(date: Date, currentSession: ReadingSession | null = null): Promise<YearReport> {
    const facts = await this.getAllDailyFacts(currentSession);
    return buildYearReport(facts, date);
  }

  async getLifetimeReport(currentSession: ReadingSession | null = null): Promise<LifetimeReport> {
    const facts = await this.getAllDailyFacts(currentSession);
    return buildLifetimeReport(facts);
  }
}

export const readingReportsService = new ReadingReportsService();
