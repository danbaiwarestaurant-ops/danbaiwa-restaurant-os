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
