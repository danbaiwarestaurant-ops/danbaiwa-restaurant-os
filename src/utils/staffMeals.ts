import { Ticket } from '../types/ticket';
import { businessDayKey } from './shiftDay';

export interface StaffMealOption {
  id: string;
  name: string;
  wageCharge: number;
  isFree: boolean;
}

export function staffMealWageDeduction(options: StaffMealOption[], baseMealsToday: number, dailyFreeLimit: number): number {
  const allowanceExceeded = options.some((option) => option.isFree) && baseMealsToday >= Math.max(0, dailyFreeLimit);
  return options.reduce((sum, option) => sum + (!option.isFree || allowanceExceeded ? Math.max(0, option.wageCharge) : 0), 0);
}

export function staffFoodCounts(tickets: Ticket[], day: string, startHour?: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const ticket of tickets) {
    if (ticket.tender !== 'staff' || ticket.status === 'void' || !ticket.staffId || businessDayKey(ticket.createdAt, startHour) !== day || !(ticket.mealOptions?.some(o => o.isFree) ?? true)) continue;
    counts[ticket.staffId] = (counts[ticket.staffId] || 0) + 1;
  }
  return counts;
}

export function staffFoodCount(tickets: Ticket[], staffId: string, day: string, startHour?: number): number {
  return staffFoodCounts(tickets, day, startHour)[staffId] || 0;
}
