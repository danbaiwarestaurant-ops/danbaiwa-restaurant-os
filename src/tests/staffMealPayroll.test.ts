import { describe, expect, it } from 'vitest';
import { staffMealWageDeduction } from '../utils/staffMeals';

const food = { id: 'food', name: 'Food', wageCharge: 500, isFree: true };
const meat = { id: 'meat', name: 'Meat', wageCharge: 700, isFree: false };

describe('staff meal wage deductions', () => {
  it('keeps base food free while the daily allowance remains', () => {
    expect(staffMealWageDeduction([food], 0, 1)).toBe(0);
  });

  it('charges one food price when the employee exceeds the allowance', () => {
    expect(staffMealWageDeduction([food], 1, 1)).toBe(500);
  });

  it('always charges add-ons and combines them with an extra meal', () => {
    expect(staffMealWageDeduction([food, meat], 1, 1)).toBe(1200);
    expect(staffMealWageDeduction([food, meat], 0, 1)).toBe(700);
  });
});
