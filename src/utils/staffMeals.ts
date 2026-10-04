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

export function staffFoodCount(tickets: Ticket[], staffId: string, day: string): number {
  return tickets.filter(t => t.tender === 'staff' && t.status !== 'void' && t.staffId === staffId && businessDayKey(t.createdAt) === day && (t.mealOptions?.some(o => o.isFree) ?? true)).length;
}
